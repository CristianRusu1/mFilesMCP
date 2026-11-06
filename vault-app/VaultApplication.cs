using System;
using System.Linq;
using MFiles.VAF;
using MFiles.VAF.Common;
using MFilesAPI;
using Newtonsoft.Json;

namespace MFilesMCP.VaultApp
{
	/// <summary>
	/// Vault extension methods for the metadata-structure reads and changes the
	/// M-Files REST API can't make. The mcp-mfiles server calls them through
	/// /REST/vault/extensionmethod/{name}; see src/structure-app.ts.
	/// </summary>
	/// <remarks>
	/// Every method answers {"ok":true,"result":...} or {"ok":false,"error":"..."}.
	/// The VAF checks RequiredVaultAccess against the calling user before a
	/// method runs. Apart from Ping and GetJob, methods only queue a job (see
	/// Jobs.cs) and return it; the work runs on the app's worker thread, through
	/// the admin session (AdminSession.cs) wherever it reads before it writes.
	/// Nothing here deletes structure: the only removals are taking a property
	/// off a class and removing a workflow transition.
	/// </remarks>
	/// <remarks>
	/// IUsesVaultExtensionMethods is required even though the methods below are
	/// declared with attributes: the VAF's task manager registers an extension
	/// method of its own during startup and throws without it. (The template
	/// base class ConfigurableVaultApplicationBase implements it.)
	/// </remarks>
	public class VaultApplication : VaultApplicationBase, IUsesVaultExtensionMethods
	{
		/// <summary>Must match STRUCTURE_APP_PROTOCOL in src/structure-app.ts.</summary>
		public const int Protocol = 3;

		// Must match STRUCTURE_APP_METHODS in src/structure-app.ts.
		public const string PingMethod = "MFilesMCP_Ping";
		public const string GetJobMethod = "MFilesMCP_GetJob";
		public const string CheckAdminSessionMethod = "MFilesMCP_CheckAdminSession";
		public const string ReadMethod = "MFilesMCP_Read";
		public const string CreatePropertyDefMethod = "MFilesMCP_CreatePropertyDef";
		public const string UpdatePropertyDefMethod = "MFilesMCP_UpdatePropertyDef";
		public const string CreateClassMethod = "MFilesMCP_CreateClass";
		public const string UpdateClassMethod = "MFilesMCP_UpdateClass";
		public const string CreateValueListMethod = "MFilesMCP_CreateValueList";
		public const string CreateWorkflowMethod = "MFilesMCP_CreateWorkflow";
		public const string UpdateWorkflowMethod = "MFilesMCP_UpdateWorkflow";
		public const string SetEventHandlerMethod = "MFilesMCP_SetEventHandler";
		public const string CreateObjectTypeMethod = "MFilesMCP_CreateObjectType";

		/// <summary>
		/// Every method this build has, reported by Ping (since 1.0.11) so the
		/// MCP server can tell whether a newer method is installed without a
		/// protocol bump: adding a method doesn't change the existing ones.
		/// </summary>
		private static readonly string[] Methods =
		{
			PingMethod, GetJobMethod, CheckAdminSessionMethod, ReadMethod,
			CreatePropertyDefMethod, UpdatePropertyDefMethod, CreateClassMethod, UpdateClassMethod,
			CreateValueListMethod, CreateWorkflowMethod, UpdateWorkflowMethod, SetEventHandlerMethod,
			CreateObjectTypeMethod,
		};

		private const MFVaultAccess StructureAccess = MFVaultAccess.MFVaultAccessChangeMetaDataStructure;

		/// <summary>
		/// What went wrong while the VAF started the app, if anything. Ping
		/// reports it so the cause is visible without the server's event log.
		/// </summary>
		private static volatile string startupError;

		private readonly AdminSession adminSession;
		private readonly JobRunner jobs;

		public VaultApplication()
		{
			// By default the VAF kills the app process when StartOperations
			// throws; M-Files restarts it, it fails again, and every call gets
			// "vault applications are still starting up" forever. Stay alive
			// and report the failure through Ping instead.
			this.KillProcessOnStartOperationsException = false;
			adminSession = new AdminSession(() => RequireVault().GetGUID());
			jobs = new JobRunner(job => new JobContext(job, adminSession, RequireVault));
		}

		public override void StartOperations(Vault vaultPersistent)
		{
			try
			{
				base.StartOperations(vaultPersistent);
			}
			catch (Exception ex)
			{
				RecordStartupError("StartOperations", ex);
				// Whatever failed is VAF infrastructure this app doesn't use (task
				// queues, admin configurations, the startup event log entry). The
				// extension methods only need PermanentVault, which the VAF sets
				// first and RequireVault checks, so let them run.
				this.applicationRunningStatus = ApplicationRunningStatus.Running;
			}
		}

		protected override void InitializeTaskManager()
		{
			// This app has no task queues, so a failure here shouldn't stop the
			// rest of the startup.
			try
			{
				base.InitializeTaskManager();
			}
			catch (Exception ex)
			{
				RecordStartupError("InitializeTaskManager", ex);
			}
		}

		private static void RecordStartupError(string step, Exception ex)
		{
			var entry = $"{step}: {ex}";
			startupError = startupError == null ? entry : startupError + Environment.NewLine + entry;
		}

		[VaultExtensionMethod(PingMethod, RequiredVaultAccess = MFVaultAccess.MFVaultAccessNone)]
		private string Ping(EventHandlerEnvironment env)
		{
			return Respond(() => new
			{
				app = "MFilesMCP",
				version = typeof(VaultApplication).Assembly.GetName().Version.ToString(),
				protocol = Protocol,
				vault_ready = this.PermanentVault != null,
				startup_error = Util.Truncate(startupError, 4000),
				process_identity = AdminSession.ProcessIdentity(),
				admin_session = adminSession.Status(),
				jobs = jobs.Status(),
				methods = Methods,
			});
		}

		[VaultExtensionMethod(GetJobMethod, RequiredVaultAccess = StructureAccess)]
		private string GetJob(EventHandlerEnvironment env)
		{
			return Respond(() =>
			{
				var request = Util.Parse<GetJobRequest>(env.Input);
				var job = jobs.Find(request.JobId);
				if (job == null)
					throw new ArgumentException(
						$"There's no job {request.JobId}. Jobs are kept in memory for two hours and are lost when the app or vault restarts.");
				return job.Snapshot();
			});
		}

		[VaultExtensionMethod(CheckAdminSessionMethod, RequiredVaultAccess = StructureAccess)]
		private string CheckAdminSession(EventHandlerEnvironment env)
		{
			return Submit<CheckAdminSessionRequest>(env, "check_admin_session", request => context =>
			{
				// Without a class to compare, failing to log in fails the job, so
				// the MCP server can retry with credentials (error_code
				// admin_login_failed).
				var admin = request.ClassId.HasValue ? context.TryAdmin() : context.Admin();
				return new
				{
					admin_session = admin != null
						? adminSession.Summary()
						: new { ok = false, error = context.AdminError },
					process_identity = AdminSession.ProcessIdentity(),
					class_reads = request.ClassId.HasValue && request.Expected != null
						? ClassChanges.CompareReads(context, request.ClassId.Value, request.Expected)
						: null,
				};
			});
		}

		[VaultExtensionMethod(ReadMethod, RequiredVaultAccess = StructureAccess)]
		private string Read(EventHandlerEnvironment env)
		{
			return Submit<ReadRequest>(env, "read", request =>
			{
				var kind = Util.RequireText(request.Kind, "kind").ToLowerInvariant();
				if (kind != "event_handlers" && !request.Id.HasValue)
					throw new ArgumentException($"id is required to read a {kind}.");
				switch (kind)
				{
					case "class":
						return context => ClassChanges.Read(context, request.Id.Value);
					case "property_def":
						return context => PropertyDefChanges.Read(context, request.Id.Value);
					case "workflow":
						return context => WorkflowChanges.Read(context, request.Id.Value);
					case "event_handlers":
						return context => EventHandlerChanges.Read(context);
					default:
						throw new ArgumentException($"kind \"{request.Kind}\" isn't one of class, property_def, workflow, event_handlers.");
				}
			});
		}

		[VaultExtensionMethod(CreatePropertyDefMethod, RequiredVaultAccess = StructureAccess)]
		private string CreatePropertyDef(EventHandlerEnvironment env)
		{
			return Submit<CreatePropertyDefRequest>(env, "create_property_def", request =>
			{
				PropertyDefChanges.Validate(request);
				return context => PropertyDefChanges.Create(context, request);
			});
		}

		[VaultExtensionMethod(UpdatePropertyDefMethod, RequiredVaultAccess = StructureAccess)]
		private string UpdatePropertyDef(EventHandlerEnvironment env)
		{
			return Submit<UpdatePropertyDefRequest>(env, "update_property_def", request =>
			{
				PropertyDefChanges.Validate(request);
				return context => PropertyDefChanges.Update(context, request);
			});
		}

		[VaultExtensionMethod(CreateClassMethod, RequiredVaultAccess = StructureAccess)]
		private string CreateClass(EventHandlerEnvironment env)
		{
			return Submit<CreateClassRequest>(env, "create_class", request =>
			{
				Util.RequireText(request.Name, "name");
				return context => ClassChanges.Create(context, request);
			});
		}

		[VaultExtensionMethod(UpdateClassMethod, RequiredVaultAccess = StructureAccess)]
		private string UpdateClass(EventHandlerEnvironment env)
		{
			return Submit<UpdateClassRequest>(env, "update_class", request => context => ClassChanges.Update(context, request));
		}

		[VaultExtensionMethod(CreateObjectTypeMethod, RequiredVaultAccess = StructureAccess)]
		private string CreateObjectType(EventHandlerEnvironment env)
		{
			return Submit<CreateObjectTypeRequest>(env, "create_object_type", request =>
			{
				Util.RequireText(request.NameSingular, "name_singular");
				return context => ObjectTypeChanges.Create(context, request);
			});
		}

		[VaultExtensionMethod(CreateValueListMethod, RequiredVaultAccess = StructureAccess)]
		private string CreateValueList(EventHandlerEnvironment env)
		{
			return Submit<CreateValueListRequest>(env, "create_value_list", request =>
			{
				Util.RequireText(request.NameSingular, "name_singular");
				return context => ValueListChanges.Create(context, request);
			});
		}

		[VaultExtensionMethod(CreateWorkflowMethod, RequiredVaultAccess = StructureAccess)]
		private string CreateWorkflow(EventHandlerEnvironment env)
		{
			return Submit<CreateWorkflowRequest>(env, "create_workflow", request =>
			{
				Util.RequireText(request.Name, "name");
				if (request.States == null || request.States.Count == 0)
					throw new ArgumentException("A workflow needs at least one state.");
				return context => WorkflowChanges.Create(context, request);
			});
		}

		[VaultExtensionMethod(UpdateWorkflowMethod, RequiredVaultAccess = StructureAccess)]
		private string UpdateWorkflow(EventHandlerEnvironment env)
		{
			return Submit<UpdateWorkflowRequest>(env, "update_workflow", request => context => WorkflowChanges.Update(context, request));
		}

		[VaultExtensionMethod(SetEventHandlerMethod, RequiredVaultAccess = StructureAccess)]
		private string SetEventHandler(EventHandlerEnvironment env)
		{
			return Submit<SetEventHandlerRequest>(env, "set_event_handler", request =>
			{
				if (string.IsNullOrWhiteSpace(request.Guid))
				{
					Util.ParseEnum<MFEventHandlerType>(request.EventType, "MFEventHandler", "event_type");
					Util.RequireText(request.Script, "script");
				}
				else if (request.EventType != null)
				{
					Util.ParseEnum<MFEventHandlerType>(request.EventType, "MFEventHandler", "event_type");
				}
				return context => EventHandlerChanges.Set(context, request);
			});
		}

		/// <summary>
		/// Parses the input, lets <paramref name="plan"/> check it and return the
		/// work, queues the work and answers with the job. Input mistakes come
		/// back at once as ok:false.
		/// </summary>
		private string Submit<T>(EventHandlerEnvironment env, string kind, Func<T, Func<JobContext, object>> plan) where T : JobRequest
		{
			return Respond(() =>
			{
				var request = Util.Parse<T>(env.Input);
				var work = plan(request);
				return jobs.Submit(kind, request, work).Snapshot();
			});
		}

		private Vault RequireVault()
		{
			var vault = this.PermanentVault;
			if (vault == null)
				throw new InvalidOperationException(startupError == null
					? "The MFilesMCP vault app hasn't finished starting; retry in a moment."
					: "The MFilesMCP vault app failed to start: " + Util.Truncate(startupError, 1000));
			return vault;
		}

		private static string Respond(Func<object> action)
		{
			try
			{
				return JsonConvert.SerializeObject(new { ok = true, result = action() });
			}
			catch (Exception ex)
			{
				return JsonConvert.SerializeObject(new { ok = false, error = Util.Describe(ex) });
			}
		}
	}
}

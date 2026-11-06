using System.Collections.Generic;
using Newtonsoft.Json;

namespace MFilesMCP.VaultApp
{
	// JSON contracts for the extension methods. Field names match what
	// src/structure-app.ts and src/structure-admin.ts send. In update requests
	// a missing (or null) field means "leave as is"; an empty script string
	// switches that script off.

	/// <summary>Fields every job-based method accepts.</summary>
	internal class JobRequest
	{
		/// <summary>
		/// Credentials for the admin session. The MCP server sends them only
		/// after logging in as the app's Windows account failed.
		/// </summary>
		[JsonProperty("login")]
		public LoginRequest Login { get; set; }

		/// <summary>The M-Files server's RPC endpoints; defaults to ncacn_ip_tcp localhost:2266.</summary>
		[JsonProperty("server_endpoints")]
		public List<ServerEndpoint> ServerEndpoints { get; set; }
	}

	internal sealed class LoginRequest
	{
		[JsonProperty("username")]
		public string Username { get; set; }

		[JsonProperty("password")]
		public string Password { get; set; }

		[JsonProperty("domain")]
		public string Domain { get; set; }
	}

	internal sealed class ServerEndpoint
	{
		[JsonProperty("protocol")]
		public string Protocol { get; set; }

		[JsonProperty("address")]
		public string Address { get; set; }

		[JsonProperty("port")]
		public string Port { get; set; }
	}

	internal sealed class GetJobRequest
	{
		[JsonProperty("job_id", Required = Required.Always)]
		public string JobId { get; set; }
	}

	internal sealed class CheckAdminSessionRequest : JobRequest
	{
		/// <summary>Optionally compare every way of reading this class with <see cref="Expected"/>.</summary>
		[JsonProperty("class_id")]
		public int? ClassId { get; set; }

		[JsonProperty("expected")]
		public ExpectedClassState Expected { get; set; }
	}

	internal sealed class ReadRequest : JobRequest
	{
		/// <summary>class, property_def, workflow or event_handlers.</summary>
		[JsonProperty("kind", Required = Required.Always)]
		public string Kind { get; set; }

		[JsonProperty("id")]
		public int? Id { get; set; }
	}

	internal sealed class CreatePropertyDefRequest : JobRequest
	{
		[JsonProperty("name", Required = Required.Always)]
		public string Name { get; set; }

		[JsonProperty("data_type", Required = Required.Always)]
		public int DataType { get; set; }

		[JsonProperty("value_list")]
		public int? ValueList { get; set; }

		[JsonProperty("object_type")]
		public int? ObjectType { get; set; }

		[JsonProperty("all_object_types")]
		public bool AllObjectTypes { get; set; }

		[JsonProperty("aliases")]
		public List<string> Aliases { get; set; }
	}

	internal sealed class UpdatePropertyDefRequest : JobRequest
	{
		[JsonProperty("property_id", Required = Required.Always)]
		public int PropertyId { get; set; }

		/// <summary>The property as the REST API shows it now.</summary>
		[JsonProperty("expected", Required = Required.Always)]
		public ExpectedPropertyDef Expected { get; set; }

		[JsonProperty("name")]
		public string Name { get; set; }

		[JsonProperty("add_aliases")]
		public List<string> AddAliases { get; set; }

		[JsonProperty("remove_aliases")]
		public List<string> RemoveAliases { get; set; }

		[JsonProperty("automatic_value")]
		public AutomaticValueRequest AutomaticValue { get; set; }

		[JsonProperty("validation")]
		public ValidationRequest Validation { get; set; }

		/// <summary>none (default), empty_only or all.</summary>
		[JsonProperty("recalculate")]
		public string Recalculate { get; set; }
	}

	internal sealed class ExpectedPropertyDef
	{
		[JsonProperty("name", Required = Required.Always)]
		public string Name { get; set; }

		[JsonProperty("data_type", Required = Required.Always)]
		public int DataType { get; set; }

		[JsonProperty("value_list")]
		public int? ValueList { get; set; }
	}

	internal sealed class AutomaticValueRequest
	{
		/// <summary>none, calculated, calculated_vbscript, auto_number or auto_number_vbscript.</summary>
		[JsonProperty("type", Required = Required.Always)]
		public string Type { get; set; }

		/// <summary>The placeholder expression for "calculated", e.g. "%PROPERTY_0% - %PROPERTY_1020%".</summary>
		[JsonProperty("expression")]
		public string Expression { get; set; }

		[JsonProperty("script")]
		public string Script { get; set; }

		[JsonProperty("increment")]
		public int? Increment { get; set; }

		[JsonProperty("calculation_order")]
		public int? CalculationOrder { get; set; }
	}

	internal sealed class ValidationRequest
	{
		/// <summary>none, regex or vbscript.</summary>
		[JsonProperty("type", Required = Required.Always)]
		public string Type { get; set; }

		[JsonProperty("regex")]
		public string Regex { get; set; }

		[JsonProperty("script")]
		public string Script { get; set; }
	}

	internal sealed class ClassPropertyRequest
	{
		[JsonProperty("property_id", Required = Newtonsoft.Json.Required.Always)]
		public int PropertyId { get; set; }

		[JsonProperty("required")]
		public bool Required { get; set; }
	}

	internal sealed class CreateClassRequest : JobRequest
	{
		[JsonProperty("object_type", Required = Required.Always)]
		public int ObjectType { get; set; }

		[JsonProperty("name", Required = Required.Always)]
		public string Name { get; set; }

		/// <summary>Defaults to the built-in Name or title (0).</summary>
		[JsonProperty("name_property_def")]
		public int? NamePropertyDef { get; set; }

		[JsonProperty("properties")]
		public List<ClassPropertyRequest> Properties { get; set; }

		[JsonProperty("workflow")]
		public int? Workflow { get; set; }

		[JsonProperty("force_workflow")]
		public bool ForceWorkflow { get; set; }

		[JsonProperty("aliases")]
		public List<string> Aliases { get; set; }
	}

	internal sealed class UpdateClassRequest : JobRequest
	{
		[JsonProperty("class_id", Required = Required.Always)]
		public int ClassId { get; set; }

		/// <summary>The class as the REST API currently shows it.</summary>
		[JsonProperty("expected", Required = Required.Always)]
		public ExpectedClassState Expected { get; set; }

		[JsonProperty("add")]
		public List<ClassPropertyRequest> Add { get; set; }

		[JsonProperty("remove")]
		public List<int> Remove { get; set; }

		[JsonProperty("name")]
		public string Name { get; set; }

		/// <summary>0 removes the workflow.</summary>
		[JsonProperty("workflow")]
		public int? Workflow { get; set; }

		[JsonProperty("force_workflow")]
		public bool? ForceWorkflow { get; set; }

		[JsonProperty("name_property_def")]
		public int? NamePropertyDef { get; set; }
	}

	/// <summary>
	/// The class definition the caller based its change on. The app refuses to
	/// save if its own copy of the class differs.
	/// </summary>
	internal sealed class ExpectedClassState
	{
		[JsonProperty("name")]
		public string Name { get; set; }

		[JsonProperty("name_property_def")]
		public int? NamePropertyDef { get; set; }

		[JsonProperty("workflow")]
		public int? Workflow { get; set; }

		[JsonProperty("force_workflow")]
		public bool? ForceWorkflow { get; set; }

		/// <summary>User-settable associated properties (built-ins left out).</summary>
		[JsonProperty("associations", Required = Required.Always)]
		public List<int> Associations { get; set; }
	}

	internal sealed class CreateObjectTypeRequest : JobRequest
	{
		[JsonProperty("name_singular", Required = Required.Always)]
		public string NameSingular { get; set; }

		[JsonProperty("name_plural")]
		public string NamePlural { get; set; }

		/// <summary>Whether objects of the type can hold files, like documents.</summary>
		[JsonProperty("can_have_files")]
		public bool CanHaveFiles { get; set; }

		/// <summary>Whether users can create objects of the type. Defaults to true.</summary>
		[JsonProperty("allow_adding")]
		public bool? AllowAdding { get; set; }

		/// <summary>The object type or value list that owns objects of this type, if any.</summary>
		[JsonProperty("owner_object_type")]
		public int? OwnerObjectType { get; set; }

		[JsonProperty("aliases")]
		public List<string> Aliases { get; set; }
	}

	internal sealed class CreateValueListRequest : JobRequest
	{
		[JsonProperty("name_singular", Required = Required.Always)]
		public string NameSingular { get; set; }

		[JsonProperty("name_plural")]
		public string NamePlural { get; set; }

		[JsonProperty("aliases")]
		public List<string> Aliases { get; set; }

		[JsonProperty("items")]
		public List<string> Items { get; set; }
	}

	internal class StateScripts
	{
		/// <summary>The state's "Run script" action.</summary>
		[JsonProperty("script")]
		public string Script { get; set; }

		[JsonProperty("preconditions_script")]
		public string PreconditionsScript { get; set; }

		[JsonProperty("postconditions_script")]
		public string PostconditionsScript { get; set; }
	}

	internal sealed class StateRequest : StateScripts
	{
		[JsonProperty("name", Required = Required.Always)]
		public string Name { get; set; }

		[JsonProperty("description")]
		public string Description { get; set; }

		[JsonProperty("aliases")]
		public List<string> Aliases { get; set; }
	}

	internal sealed class StateUpdateRequest : StateScripts
	{
		[JsonProperty("id", Required = Required.Always)]
		public int Id { get; set; }

		[JsonProperty("name")]
		public string Name { get; set; }

		[JsonProperty("description")]
		public string Description { get; set; }
	}

	internal sealed class TriggerRequest
	{
		/// <summary>none, script, days, assignment_complete, assignment_complete_one, assignment_complete_all or assignment_rejected.</summary>
		[JsonProperty("mode", Required = Required.Always)]
		public string Mode { get; set; }

		[JsonProperty("script")]
		public string Script { get; set; }

		[JsonProperty("days")]
		public int? Days { get; set; }
	}

	internal sealed class TransitionRequest
	{
		[JsonProperty("from_state")]
		public int? FromState { get; set; }

		[JsonProperty("from_state_name")]
		public string FromStateName { get; set; }

		[JsonProperty("to_state")]
		public int? ToState { get; set; }

		[JsonProperty("to_state_name")]
		public string ToStateName { get; set; }

		[JsonProperty("name")]
		public string Name { get; set; }

		[JsonProperty("description")]
		public string Description { get; set; }

		[JsonProperty("trigger")]
		public TriggerRequest Trigger { get; set; }
	}

	internal sealed class TransitionUpdateRequest
	{
		[JsonProperty("id", Required = Required.Always)]
		public int Id { get; set; }

		[JsonProperty("from_state")]
		public int? FromState { get; set; }

		[JsonProperty("to_state")]
		public int? ToState { get; set; }

		[JsonProperty("name")]
		public string Name { get; set; }

		[JsonProperty("description")]
		public string Description { get; set; }

		[JsonProperty("trigger")]
		public TriggerRequest Trigger { get; set; }
	}

	internal sealed class CreateWorkflowRequest : JobRequest
	{
		[JsonProperty("name", Required = Required.Always)]
		public string Name { get; set; }

		[JsonProperty("description")]
		public string Description { get; set; }

		[JsonProperty("aliases")]
		public List<string> Aliases { get; set; }

		[JsonProperty("states", Required = Required.Always)]
		public List<StateRequest> States { get; set; }

		[JsonProperty("transitions")]
		public List<TransitionRequest> Transitions { get; set; }
	}

	internal sealed class UpdateWorkflowRequest : JobRequest
	{
		[JsonProperty("workflow_id", Required = Required.Always)]
		public int WorkflowId { get; set; }

		/// <summary>The workflow as the REST API shows it now.</summary>
		[JsonProperty("expected", Required = Required.Always)]
		public ExpectedWorkflow Expected { get; set; }

		[JsonProperty("name")]
		public string Name { get; set; }

		[JsonProperty("description")]
		public string Description { get; set; }

		[JsonProperty("add_states")]
		public List<StateRequest> AddStates { get; set; }

		[JsonProperty("update_states")]
		public List<StateUpdateRequest> UpdateStates { get; set; }

		[JsonProperty("add_transitions")]
		public List<TransitionRequest> AddTransitions { get; set; }

		[JsonProperty("update_transitions")]
		public List<TransitionUpdateRequest> UpdateTransitions { get; set; }

		[JsonProperty("remove_transitions")]
		public List<int> RemoveTransitions { get; set; }
	}

	internal sealed class ExpectedWorkflow
	{
		[JsonProperty("name")]
		public string Name { get; set; }

		[JsonProperty("states", Required = Required.Always)]
		public List<int> States { get; set; }
	}

	internal sealed class SetEventHandlerRequest : JobRequest
	{
		/// <summary>The handler to change; leave out to add a new one.</summary>
		[JsonProperty("guid")]
		public string Guid { get; set; }

		[JsonProperty("event_type")]
		public string EventType { get; set; }

		/// <summary>The handler's description; for VaultExtensionMethod handlers, the method name.</summary>
		[JsonProperty("name")]
		public string Name { get; set; }

		[JsonProperty("script")]
		public string Script { get; set; }

		[JsonProperty("active")]
		public bool? Active { get; set; }

		/// <summary>Every handler GUID as the caller last read them; refuses if the list changed since.</summary>
		[JsonProperty("expected_guids", Required = Required.Always)]
		public List<string> ExpectedGuids { get; set; }
	}
}

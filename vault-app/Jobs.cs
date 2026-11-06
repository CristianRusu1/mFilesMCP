using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Diagnostics;
using System.Linq;
using System.Threading;
using MFilesAPI;

namespace MFilesMCP.VaultApp
{
	/// <summary>
	/// A structure change or admin read that runs on the app's worker thread.
	/// </summary>
	/// <remarks>
	/// Extension methods only queue the work and return the job; the MCP
	/// server polls MFilesMCP_GetJob. Structure changes made while the
	/// extension method waited took 20 seconds to 2 minutes, longer than MCP
	/// clients wait for a tool call, and kept the request's transaction open
	/// the whole time.
	/// </remarks>
	internal sealed class Job
	{
		private readonly object sync = new object();
		private string status = "queued";
		private string step;
		private DateTime? startedUtc;
		private DateTime? finishedUtc;
		private object result;
		private string error;
		private string errorCode;
		private Dictionary<string, object> diagnostics;
		private string lateNote;

		public Job(string kind, JobRequest request, Func<JobContext, object> work)
		{
			Kind = kind;
			Request = request;
			Work = work;
		}

		public string Id { get; } = Guid.NewGuid().ToString("N");
		public string Kind { get; }
		public JobRequest Request { get; }
		public Func<JobContext, object> Work { get; }
		public DateTime CreatedUtc { get; } = DateTime.UtcNow;

		public DateTime? FinishedUtc
		{
			get { lock (sync) return finishedUtc; }
		}

		public void SetStep(string text)
		{
			lock (sync) step = text;
		}

		public void Start()
		{
			lock (sync)
			{
				status = "running";
				startedUtc = DateTime.UtcNow;
			}
		}

		public void Succeed(object value, Dictionary<string, object> details)
		{
			lock (sync)
			{
				result = value;
				diagnostics = details;
				status = "succeeded";
				finishedUtc = DateTime.UtcNow;
			}
		}

		/// <summary>What happened to a save call the job stopped waiting for.</summary>
		public void NoteLateResult(string text)
		{
			lock (sync) lateNote = text;
		}

		public void Fail(string message, string code, Dictionary<string, object> details)
		{
			lock (sync)
			{
				error = message;
				errorCode = code;
				diagnostics = details;
				status = "failed";
				finishedUtc = DateTime.UtcNow;
			}
		}

		public object Snapshot()
		{
			lock (sync)
			{
				var now = DateTime.UtcNow;
				return new
				{
					job_id = Id,
					kind = Kind,
					status,
					step,
					queued_ms = (long)((startedUtc ?? now) - CreatedUtc).TotalMilliseconds,
					elapsed_ms = startedUtc.HasValue
						? (long?)((finishedUtc ?? now) - startedUtc.Value).TotalMilliseconds
						: null,
					result,
					error,
					error_code = errorCode,
					late_note = lateNote,
					diagnostics,
				};
			}
		}
	}

	/// <summary>Runs jobs one at a time, in the order they were queued.</summary>
	internal sealed class JobRunner
	{
		private static readonly TimeSpan KeepFinishedFor = TimeSpan.FromHours(2);

		private readonly BlockingCollection<Job> queue = new BlockingCollection<Job>();
		private readonly ConcurrentDictionary<string, Job> jobs = new ConcurrentDictionary<string, Job>();
		private readonly Func<Job, JobContext> createContext;
		private readonly object startLock = new object();
		private Thread worker;
		private volatile Job current;

		public JobRunner(Func<Job, JobContext> createContext)
		{
			this.createContext = createContext;
		}

		public Job Submit(string kind, JobRequest request, Func<JobContext, object> work)
		{
			var job = new Job(kind, request, work);
			Prune();
			jobs[job.Id] = job;
			EnsureWorker();
			queue.Add(job);
			return job;
		}

		public Job Find(string id)
		{
			Job job;
			return id != null && jobs.TryGetValue(id.Trim(), out job) ? job : null;
		}

		public object Status()
		{
			var running = current;
			return new
			{
				queued = queue.Count,
				running = running == null ? null : new { job_id = running.Id, kind = running.Kind },
			};
		}

		private void EnsureWorker()
		{
			lock (startLock)
			{
				if (worker != null)
					return;
				worker = new Thread(Run)
				{
					IsBackground = true,
					Name = "MFilesMCP structure jobs",
				};
				worker.SetApartmentState(ApartmentState.MTA);
				worker.Start();
			}
		}

		private void Run()
		{
			foreach (var job in queue.GetConsumingEnumerable())
			{
				current = job;
				try
				{
					Execute(job);
				}
				finally
				{
					current = null;
				}
			}
		}

		private void Execute(Job job)
		{
			job.Start();
			JobContext context = null;
			try
			{
				context = createContext(job);
				var timer = Stopwatch.StartNew();
				var result = job.Work(context);
				context.Diagnostics["elapsed_ms"] = timer.ElapsedMilliseconds;
				job.Succeed(result, context.Diagnostics);
			}
			catch (Exception ex)
			{
				job.Fail(Util.Describe(ex), ex is AdminSessionException ? "admin_login_failed" : null, context?.Diagnostics);
			}
		}

		private void Prune()
		{
			var cutoff = DateTime.UtcNow - KeepFinishedFor;
			foreach (var old in jobs.Values.Where(j => j.FinishedUtc.HasValue && j.FinishedUtc.Value < cutoff).ToList())
			{
				Job removed;
				jobs.TryRemove(old.Id, out removed);
			}
		}
	}

	/// <summary>What a job can use: the admin session, PermanentVault, and a place for diagnostics.</summary>
	internal sealed class JobContext
	{
		private readonly AdminSession adminSession;
		private readonly Func<Vault> permanentVault;
		private Vault admin;
		private string adminError;

		public JobContext(Job job, AdminSession adminSession, Func<Vault> permanentVault)
		{
			Job = job;
			this.adminSession = adminSession;
			this.permanentVault = permanentVault;
		}

		public Job Job { get; }
		public Dictionary<string, object> Diagnostics { get; } = new Dictionary<string, object>();

		/// <summary>Why the admin session couldn't be opened, once TryAdmin has failed.</summary>
		public string AdminError => adminError;

		public void Step(string text)
		{
			Job.SetStep(text);
		}

		/// <summary>The administrative session. Throws AdminSessionException if it can't be opened.</summary>
		public Vault Admin()
		{
			var vault = TryAdmin();
			if (vault == null)
				throw new AdminSessionException("Couldn't open an administrative session to the vault: " + adminError);
			return vault;
		}

		/// <summary>The administrative session, or null if it can't be opened (AdminError says why).</summary>
		public Vault TryAdmin()
		{
			if (admin != null || adminError != null)
				return admin;
			Step("opening the admin session");
			try
			{
				admin = adminSession.Get(Job.Request?.Login, Job.Request?.ServerEndpoints, Diagnostics);
				if (admin == null)
					adminError = adminSession.LastError ?? "no login worked";
			}
			catch (Exception ex)
			{
				adminError = Util.Describe(ex);
			}
			Diagnostics["admin_session"] = admin != null
				? adminSession.Summary()
				: new { ok = false, error = adminError };
			return admin;
		}

		/// <summary>
		/// For changes that don't read anything first (creating structure):
		/// the admin session if it opens, else PermanentVault.
		/// </summary>
		public Vault AdminOrPermanent()
		{
			var vault = TryAdmin();
			Diagnostics["channel"] = vault != null ? "admin session" : "PermanentVault";
			return vault ?? Permanent();
		}

		public Vault Permanent()
		{
			return permanentVault();
		}
	}
}

using System;
using System.Collections.Generic;
using System.Linq;
using System.Threading;
using MFilesAPI;
using Newtonsoft.Json;

namespace MFilesMCP.VaultApp
{
	internal static class Util
	{
		public static T Parse<T>(string input) where T : class
		{
			var value = string.IsNullOrWhiteSpace(input)
				? null
				: JsonConvert.DeserializeObject<T>(input);
			if (value == null)
				throw new ArgumentException("Expected a JSON object as input.");
			return value;
		}

		public static string RequireText(string value, string field)
		{
			if (string.IsNullOrWhiteSpace(value))
				throw new ArgumentException($"{field} is required.");
			return value.Trim();
		}

		public static string NullIfEmpty(string value)
		{
			return string.IsNullOrEmpty(value) ? null : value;
		}

		public static string JoinAliases(IEnumerable<string> aliases)
		{
			return string.Join(";", (aliases ?? Enumerable.Empty<string>())
				.Select(a => a?.Trim())
				.Where(a => !string.IsNullOrEmpty(a)));
		}

		public static List<string> SplitAliases(SemanticAliases aliases)
		{
			var value = aliases?.Value;
			return string.IsNullOrWhiteSpace(value)
				? new List<string>()
				: value.Split(';').Select(a => a.Trim()).Where(a => a.Length > 0).ToList();
		}

		/// <summary>The current aliases plus additions, minus removals, in their original order.</summary>
		public static string MergeAliases(SemanticAliases current, IEnumerable<string> add, IEnumerable<string> remove)
		{
			var removed = new HashSet<string>((remove ?? Enumerable.Empty<string>()).Select(a => a.Trim()), StringComparer.OrdinalIgnoreCase);
			var result = SplitAliases(current).Where(a => !removed.Contains(a)).ToList();
			foreach (var alias in (add ?? Enumerable.Empty<string>()).Select(a => a?.Trim()).Where(a => !string.IsNullOrEmpty(a)))
			{
				if (!result.Contains(alias, StringComparer.OrdinalIgnoreCase))
					result.Add(alias);
			}
			return string.Join(";", result);
		}

		/// <summary>
		/// The exception's message without the source locations and binary
		/// blob M-Files appends to its COM errors, plus the HRESULT if there is one.
		/// </summary>
		public static string Describe(Exception ex)
		{
			var message = (ex.Message ?? ex.GetType().Name).Trim();
			var firstLine = message.Split(new[] { '\r', '\n' }, StringSplitOptions.RemoveEmptyEntries).FirstOrDefault() ?? message;
			var code = System.Text.RegularExpressions.Regex.Match(message, @"\(0x[0-9A-Fa-f]{8}\)");
			if (code.Success && !firstLine.Contains(code.Value))
				firstLine += " " + code.Value;
			return Truncate(firstLine, 1000);
		}

		/// <summary>E_NOTIMPL: the server doesn't implement this call.</summary>
		public static bool IsNotImplemented(Exception ex)
		{
			return unchecked((uint)ex.HResult) == 0x80004001
				|| (ex.Message ?? "").IndexOf("0x80004001", StringComparison.OrdinalIgnoreCase) >= 0;
		}

		public static string Truncate(string text, int max)
		{
			return text == null || text.Length <= max ? text : text.Substring(0, max) + "…";
		}

		public static string Attempt(Func<string> read)
		{
			try
			{
				return read();
			}
			catch (Exception ex)
			{
				return "failed: " + Describe(ex);
			}
		}

		public static List<KeyValuePair<int, bool>> ReadAssociations(AssociatedPropertyDefs associations)
		{
			var list = new List<KeyValuePair<int, bool>>();
			if (associations == null)
				return list;
			foreach (AssociatedPropertyDef a in associations)
				list.Add(new KeyValuePair<int, bool>(a.PropertyDef, a.Required));
			return list;
		}

		public static string Format(IEnumerable<KeyValuePair<int, bool>> associations)
		{
			return "[" + string.Join(", ", associations.Select(a => a.Key + (a.Value ? " required" : ""))) + "]";
		}

		/// <summary>An M-Files enum value's name without its prefix, e.g. "BeforeCheckInChanges".</summary>
		public static string EnumName<T>(T value, string prefix) where T : struct
		{
			var name = value.ToString();
			return name.StartsWith(prefix, StringComparison.Ordinal) && name.Length > prefix.Length
				? name.Substring(prefix.Length)
				: name;
		}

		/// <summary>Accepts the number, the full enum name, or the name without its prefix.</summary>
		public static T ParseEnum<T>(string text, string prefix, string field) where T : struct
		{
			var value = RequireText(text, field);
			int number;
			if (int.TryParse(value, out number) && Enum.IsDefined(typeof(T), number))
				return (T)Enum.ToObject(typeof(T), number);
			foreach (var name in Enum.GetNames(typeof(T)))
			{
				if (string.Equals(name, value, StringComparison.OrdinalIgnoreCase)
					|| string.Equals(name, prefix + value, StringComparison.OrdinalIgnoreCase))
					return (T)Enum.Parse(typeof(T), name);
			}
			throw new ArgumentException($"{field} \"{value}\" is not one of: {string.Join(", ", Enum.GetNames(typeof(T)).Select(n => n.StartsWith(prefix) ? n.Substring(prefix.Length) : n))}.");
		}

		/// <summary>
		/// Runs a structure save, and stops waiting for it once the change shows.
		/// On M-Files 25.11 a class save is applied within seconds (REST shows
		/// it) but the call can stay open for a minute or more, holding up every
		/// job queued behind it. After <paramref name="patience"/> this polls
		/// <paramref name="applied"/> and returns as soon as it's true; what the
		/// save call does later is noted on the job.
		/// </summary>
		public static void SaveAndConfirm(JobContext context, Action save, Func<bool> applied, TimeSpan patience)
		{
			var timer = System.Diagnostics.Stopwatch.StartNew();
			var task = System.Threading.Tasks.Task.Factory.StartNew(save, CancellationToken.None,
				System.Threading.Tasks.TaskCreationOptions.LongRunning, System.Threading.Tasks.TaskScheduler.Default);
			try
			{
				if (task.Wait(patience))
				{
					context.Diagnostics["save_ms"] = timer.ElapsedMilliseconds;
					return;
				}
				while (!task.Wait(TimeSpan.FromSeconds(2)))
				{
					bool done;
					try
					{
						done = applied();
					}
					catch
					{
						done = false;
					}
					if (!done)
						continue;
					context.Diagnostics["save"] =
						$"M-Files applied the change within {timer.Elapsed.TotalSeconds:0} seconds but kept the save call open; the app stopped waiting for it.";
					var job = context.Job;
					task.ContinueWith(t => job.NoteLateResult(t.IsFaulted
						? $"The save call failed after {timer.Elapsed.TotalSeconds:0} seconds: {Describe(t.Exception.InnerException)}"
						: $"The save call returned after {timer.Elapsed.TotalSeconds:0} seconds."));
					return;
				}
				context.Diagnostics["save_ms"] = timer.ElapsedMilliseconds;
			}
			catch (AggregateException ex)
			{
				System.Runtime.ExceptionServices.ExceptionDispatchInfo.Capture(ex.InnerException).Throw();
			}
		}

		/// <summary>
		/// Runs a call that could hang (logging in, opening a session) on its
		/// own thread so a stuck call can't block the job worker forever.
		/// </summary>
		public static T WithTimeout<T>(Func<T> action, TimeSpan timeout, string what)
		{
			var result = default(T);
			Exception error = null;
			var thread = new Thread(() =>
			{
				try
				{
					result = action();
				}
				catch (Exception ex)
				{
					error = ex;
				}
			})
			{
				IsBackground = true,
				Name = "MFilesMCP " + what,
			};
			thread.SetApartmentState(ApartmentState.MTA);
			thread.Start();
			if (!thread.Join(timeout))
				throw new TimeoutException($"{what} didn't finish within {timeout.TotalSeconds:0} seconds.");
			if (error != null)
				throw error;
			return result;
		}
	}
}

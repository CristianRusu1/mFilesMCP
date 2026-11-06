using System;
using System.Collections.Generic;
using System.Security.Principal;
using MFilesAPI;

namespace MFilesMCP.VaultApp
{
	/// <summary>
	/// No administrative session could be opened. The job fails with
	/// error_code "admin_login_failed", and the MCP server retries with the
	/// user's credentials if it has them.
	/// </summary>
	internal sealed class AdminSessionException : Exception
	{
		public AdminSessionException(string message) : base(message)
		{
		}
	}

	/// <summary>
	/// An administrative session to this vault, opened the way M-Files Admin
	/// opens one: a connection of its own to the local M-Files server, then
	/// LogInToVaultAdministrative.
	/// </summary>
	/// <remarks>
	/// PermanentVault, the session the VAF hands the app, can't be trusted for
	/// read-modify-write changes. On M-Files 25.11 its admin reads of a class
	/// list only the class's name property, and saving such a copy removes the
	/// rest. This session goes through the M-Files API's own server connection
	/// instead, the path M-Files Admin uses. It logs in as the Windows account
	/// the app runs under (normally LocalSystem, which M-Files treats as a server
	/// administrator) and, if that fails and the caller sent credentials, with
	/// those. Only the job worker thread uses it.
	/// </remarks>
	internal sealed class AdminSession
	{
		private static readonly TimeSpan LoginTimeout = TimeSpan.FromSeconds(60);
		private static readonly TimeSpan RetryWindowsLoginAfter = TimeSpan.FromMinutes(10);
		private static readonly ServerEndpoint[] DefaultEndpoints =
		{
			new ServerEndpoint { Protocol = "ncacn_ip_tcp", Address = "localhost", Port = "2266" },
		};

		private readonly Func<string> vaultGuid;
		private MFilesServerApplication server;
		private Vault vault;
		private DateTime? windowsLoginFailedUtc;

		// Reported by Ping, which runs on other threads.
		private volatile string state = "not_tried";
		private volatile string login;
		private volatile string account;
		private volatile string lastError;

		public AdminSession(Func<string> vaultGuid)
		{
			this.vaultGuid = vaultGuid;
		}

		public string LastError => lastError;

		public static string ProcessIdentity()
		{
			return Util.Attempt(() => WindowsIdentity.GetCurrent().Name);
		}

		public object Status()
		{
			return new { state, login, account, error = lastError };
		}

		public object Summary()
		{
			return new { ok = true, login, account };
		}

		/// <summary>
		/// The open session, reconnecting if it dropped, or null if no login
		/// worked (LastError lists every attempt).
		/// </summary>
		public Vault Get(LoginRequest credentials, IList<ServerEndpoint> endpoints, IDictionary<string, object> diagnostics)
		{
			if (vault != null)
			{
				try
				{
					vault.TestConnectionToVault();
					return vault;
				}
				catch (Exception ex)
				{
					diagnostics["admin_session_reconnected_after"] = Util.Describe(ex);
					Close();
				}
			}

			var guid = vaultGuid();
			var attempts = new List<string>();
			foreach (var candidate in Candidates(credentials, endpoints))
			{
				MFilesServerApplication connection = null;
				try
				{
					Vault opened;
					try
					{
						opened = Util.WithTimeout(() =>
						{
							connection = new MFilesServerApplication();
							candidate.Connect(connection, encrypted: false);
							return LogIn(connection, guid);
						}, LoginTimeout, "admin login");
					}
					catch (Exception ex) when ((ex.Message ?? "").IndexOf("encrypt", StringComparison.OrdinalIgnoreCase) >= 0)
					{
						// The server only accepts encrypted connections.
						LogOut(null, connection);
						opened = Util.WithTimeout(() =>
						{
							connection = new MFilesServerApplication();
							candidate.Connect(connection, encrypted: true);
							return LogIn(connection, guid);
						}, LoginTimeout, "admin login");
					}
					var who = Util.Attempt(() => opened.SessionInfo.AccountName);
					if (!opened.SessionInfo.CheckVaultAccess(MFVaultAccess.MFVaultAccessChangeMetaDataStructure))
					{
						attempts.Add($"{candidate.Description}: logged in as {who}, who lacks the 'Change metadata structure' right");
						LogOut(opened, connection);
						continue;
					}
					server = connection;
					vault = opened;
					login = candidate.Description;
					account = who;
					state = "connected";
					lastError = null;
					if (candidate.IsServiceAccount)
						windowsLoginFailedUtc = null;
					if (attempts.Count > 0)
						diagnostics["admin_login_attempts"] = attempts;
					return vault;
				}
				catch (Exception ex)
				{
					attempts.Add($"{candidate.Description}: {Util.Describe(ex)}");
					if (candidate.IsServiceAccount)
						windowsLoginFailedUtc = DateTime.UtcNow;
					LogOut(null, connection);
				}
			}

			state = "failed";
			lastError = attempts.Count == 0 ? "No login to try." : string.Join(" | ", attempts);
			diagnostics["admin_login_attempts"] = attempts;
			return null;
		}

		private IEnumerable<LoginCandidate> Candidates(LoginRequest credentials, IList<ServerEndpoint> endpoints)
		{
			var targets = endpoints != null && endpoints.Count > 0 ? endpoints : (IList<ServerEndpoint>)DefaultEndpoints;
			var haveCredentials = credentials != null && !string.IsNullOrEmpty(credentials.Username);
			// With credentials on hand, don't wait on a Windows login that just failed.
			var tryServiceAccount = !haveCredentials
				|| !windowsLoginFailedUtc.HasValue
				|| DateTime.UtcNow - windowsLoginFailedUtc.Value > RetryWindowsLoginAfter;
			// One credential login per endpoint, of the account type the name
			// suggests: failed logins can count towards an account lockout.
			var windowsAccount = haveCredentials
				&& (!string.IsNullOrEmpty(credentials.Domain) || credentials.Username.Contains("\\"));
			foreach (var target in targets)
			{
				if (tryServiceAccount)
					yield return LoginCandidate.ServiceAccount(target);
				if (haveCredentials)
					yield return windowsAccount
						? LoginCandidate.WindowsUser(target, credentials)
						: LoginCandidate.MFilesUser(target, credentials);
			}
		}

		private static Vault LogIn(MFilesServerApplication connection, string guid)
		{
			try
			{
				return connection.LogInToVaultAdministrative(guid);
			}
			catch (Exception adminLogin)
			{
				try
				{
					return connection.LogInToVault(guid);
				}
				catch (Exception plainLogin)
				{
					throw new InvalidOperationException(
						$"LogInToVaultAdministrative: {Util.Describe(adminLogin)}; LogInToVault: {Util.Describe(plainLogin)}");
				}
			}
		}

		private void Close()
		{
			LogOut(vault, server);
			vault = null;
			server = null;
			state = "disconnected";
		}

		private static void LogOut(Vault opened, MFilesServerApplication connection)
		{
			try
			{
				opened?.LogOutSilent();
			}
			catch
			{
				// Already gone.
			}
			try
			{
				connection?.Disconnect();
			}
			catch
			{
				// Already gone.
			}
		}

		private sealed class LoginCandidate
		{
			private ServerEndpoint target;
			private MFAuthType authType;
			private LoginRequest credentials;

			public string Description { get; private set; }
			public bool IsServiceAccount { get; private set; }

			public static LoginCandidate ServiceAccount(ServerEndpoint target)
			{
				return new LoginCandidate
				{
					target = target,
					authType = MFAuthType.MFAuthTypeLoggedOnWindowsUser,
					IsServiceAccount = true,
					Description = $"app's Windows account ({ProcessIdentity()}) via {Describe(target)}",
				};
			}

			public static LoginCandidate MFilesUser(ServerEndpoint target, LoginRequest credentials)
			{
				return new LoginCandidate
				{
					target = target,
					authType = MFAuthType.MFAuthTypeSpecificMFilesUser,
					credentials = credentials,
					Description = $"M-Files user {credentials.Username} via {Describe(target)}",
				};
			}

			public static LoginCandidate WindowsUser(ServerEndpoint target, LoginRequest credentials)
			{
				return new LoginCandidate
				{
					target = target,
					authType = MFAuthType.MFAuthTypeSpecificWindowsUser,
					credentials = credentials,
					Description = $"Windows user {credentials.Username} via {Describe(target)}",
				};
			}

			public void Connect(MFilesServerApplication connection, bool encrypted)
			{
				var timeZone = new TimeZoneInformation();
				timeZone.LoadWithCurrentTimeZone();
				var protocol = target.Protocol ?? "ncacn_ip_tcp";
				var address = target.Address ?? "localhost";
				var port = target.Port ?? "2266";
				object user = Type.Missing;
				object password = Type.Missing;
				object domain = Type.Missing;
				if (credentials != null)
				{
					var name = credentials.Username;
					var domainName = credentials.Domain;
					var slash = name.IndexOf('\\');
					if (authType == MFAuthType.MFAuthTypeSpecificWindowsUser && string.IsNullOrEmpty(domainName) && slash > 0)
					{
						domainName = name.Substring(0, slash);
						name = name.Substring(slash + 1);
					}
					user = name;
					password = credentials.Password ?? "";
					if (!string.IsNullOrEmpty(domainName))
						domain = domainName;
				}
				var result = connection.ConnectAdministrativeEx(timeZone, authType, user, password, domain,
					Type.Missing, protocol, address, port, encrypted, "");
				if (result != MFServerConnection.MFServerConnectionAuthenticated)
					throw new InvalidOperationException($"the server answered {result} instead of an authenticated connection");
			}

			private static string Describe(ServerEndpoint target)
			{
				return $"{target.Protocol ?? "ncacn_ip_tcp"} {target.Address ?? "localhost"}:{target.Port ?? "2266"}";
			}
		}
	}
}

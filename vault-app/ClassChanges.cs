using System;
using System.Collections.Generic;
using System.Linq;
using System.Threading;
using MFilesAPI;

namespace MFilesMCP.VaultApp
{
	/// <summary>
	/// Class reads and changes.
	/// </summary>
	/// <remarks>
	/// On M-Files 25.11 every admin read of a class (GetObjectClassAdmin and
	/// friends, through any session, including one opened like M-Files Admin's)
	/// lists only the class's name property in AssociatedPropertyDefs. The
	/// regular read (GetObjectClass, which REST also shows) has the full list,
	/// and saving a full list with UpdateObjectClassAdmin works. So when the
	/// admin copy only lacks properties, the app takes the list from the
	/// regular read, after checking that the regular read matches the caller's
	/// REST view and that the admin copy's permissions and aliases agree with
	/// what the vault reports elsewhere.
	/// </remarks>
	internal static class ClassChanges
	{
		private static readonly TimeSpan OpenTimeout = TimeSpan.FromSeconds(30);

		private sealed class LoadedClass
		{
			public string Channel;
			public Vault Vault;
			public ObjectClassAdmin Class;
			/// <summary>The class's user properties to work from.</summary>
			public List<KeyValuePair<int, bool>> Associations;
			/// <summary>True when Associations come from the regular read.</summary>
			public bool FromRegularRead;
		}

		public static object Read(JobContext context, int classId)
		{
			var vault = context.Admin();
			var admin = vault.ClassOperations.GetObjectClassAdmin(classId);
			var adminList = Util.ReadAssociations(admin.AssociatedPropertyDefs);
			var updateTypes = new Dictionary<int, MFUpdateType>();
			var userList = Util.ReadAssociations(vault.ClassOperations.GetObjectClass(classId).AssociatedPropertyDefs)
				.Where(a => IsNormal(vault, a.Key, updateTypes))
				.ToList();
			var complete = userList.All(r => adminList.Any(a => a.Key == r.Key));
			return new
			{
				@class = Views.Class(admin, complete ? adminList : userList),
				admin_copy_associations = complete ? null : adminList.Select(a => new { property_id = a.Key, required = a.Value }).ToList(),
				note = complete
					? null
					: "M-Files' admin copy of this class lists fewer properties than the class has, so associated_property_defs comes from the regular read (user-settable properties only).",
			};
		}

		/// <summary>What every way of reading the class returns, compared with the caller's view.</summary>
		public static List<string> CompareReads(JobContext context, int classId, ExpectedClassState expected)
		{
			var reads = new List<string>();
			Load(context, classId, expected, reads, stopAtMatch: false);
			return reads;
		}

		public static object Create(JobContext context, CreateClassRequest request)
		{
			var name = Util.RequireText(request.Name, "name");
			var nameProperty = request.NamePropertyDef ?? 0;
			var vault = context.AdminOrPermanent();

			var admin = new ObjectClassAdmin();
			admin.Name = name;
			admin.ObjectType = request.ObjectType;
			admin.NamePropertyDef = nameProperty;
			admin.Workflow = request.Workflow ?? 0;
			admin.ForceWorkflow = request.Workflow.HasValue && request.Workflow.Value != 0 && request.ForceWorkflow;

			// The name property is always on the class, and required.
			var desired = new List<KeyValuePair<int, bool>> { new KeyValuePair<int, bool>(nameProperty, true) };
			foreach (var p in request.Properties ?? new List<ClassPropertyRequest>())
			{
				if (!desired.Any(d => d.Key == p.PropertyId))
					desired.Add(new KeyValuePair<int, bool>(p.PropertyId, p.Required));
			}
			admin.AssociatedPropertyDefs = BuildAssociations(desired, $"new class \"{name}\"");

			var aliases = Util.JoinAliases(request.Aliases);
			if (aliases.Length > 0)
			{
				if (admin.SemanticAliases == null)
					admin.SemanticAliases = new SemanticAliases();
				admin.SemanticAliases.Value = aliases;
			}

			context.Step("creating the class");
			var created = vault.ClassOperations.AddObjectClassAdmin(admin);
			context.Step("checking the new class");
			var saved = WaitForRegularRead(vault, created.ID, desired, new HashSet<int>());
			var updateTypes = new Dictionary<int, MFUpdateType>();
			return new
			{
				@class = Views.Class(created, saved.Associations.Where(a => IsNormal(vault, a.Key, updateTypes)).ToList()),
				warning = saved.Problem,
			};
		}

		public static object Update(JobContext context, UpdateClassRequest request)
		{
			var additions = request.Add ?? new List<ClassPropertyRequest>();
			var removals = new HashSet<int>(request.Remove ?? new List<int>());
			var requiredById = new Dictionary<int, bool>();
			foreach (var add in additions)
				requiredById[add.PropertyId] = add.Required;

			context.Step("reading the class");
			var reads = new List<string>();
			var loaded = Load(context, request.ClassId, request.Expected, reads, stopAtMatch: true);
			context.Diagnostics["class_reads"] = reads;
			if (loaded == null)
			{
				context.Diagnostics["session"] = Util.Attempt(() =>
					context.Permanent().SessionInfo.AccountName + " (user " + context.Permanent().SessionInfo.UserID + ")");
				var message = $"Not saving class {request.ClassId}: no way of reading it gave a copy that matches the class as it is now ({string.Join(" | ", reads)}). Saving a copy that differs would undo changes, so nothing was changed.";
				if (context.AdminError != null)
					throw new AdminSessionException(message + " The admin session, which reads classes the way M-Files Admin does, couldn't be opened: " + context.AdminError);
				throw new InvalidOperationException(message);
			}
			context.Diagnostics["channel"] = loaded.Channel;
			var vault = loaded.Vault;
			var objectClass = loaded.Class;
			var before = Views.Class(objectClass, loaded.Associations);

			if (request.Name != null)
				objectClass.Name = Util.RequireText(request.Name, "name");
			if (request.Workflow.HasValue)
				objectClass.Workflow = request.Workflow.Value;
			if (request.ForceWorkflow.HasValue)
				objectClass.ForceWorkflow = request.ForceWorkflow.Value;
			if (objectClass.Workflow == 0)
				objectClass.ForceWorkflow = false;
			if (request.NamePropertyDef.HasValue)
				objectClass.NamePropertyDef = request.NamePropertyDef.Value;
			if (removals.Contains(objectClass.NamePropertyDef))
				throw new ArgumentException($"Property {objectClass.NamePropertyDef} is the class's name property and can't be removed from it.");

			// Desired list: existing entries in order (minus removals, with
			// updated Required flags), then the new ones.
			var desired = new List<KeyValuePair<int, bool>>();
			foreach (var existing in loaded.Associations)
			{
				if (removals.Contains(existing.Key))
					continue;
				bool required;
				desired.Add(new KeyValuePair<int, bool>(existing.Key,
					requiredById.TryGetValue(existing.Key, out required) ? required : existing.Value));
			}
			foreach (var add in additions)
			{
				if (!desired.Any(d => d.Key == add.PropertyId))
					desired.Add(new KeyValuePair<int, bool>(add.PropertyId, add.Required));
			}
			if (!desired.Any(d => d.Key == objectClass.NamePropertyDef))
				desired.Insert(0, new KeyValuePair<int, bool>(objectClass.NamePropertyDef, true));

			objectClass.AssociatedPropertyDefs = BuildAssociations(desired, $"class {request.ClassId}");
			context.Step("saving the class");
			Util.SaveAndConfirm(context,
				() => vault.ClassOperations.UpdateObjectClassAdmin(objectClass),
				() => Shows(Util.ReadAssociations(vault.ClassOperations.GetObjectClass(request.ClassId).AssociatedPropertyDefs), desired, removals),
				SavePatience);

			context.Step("checking the saved class");
			var after = vault.ClassOperations.GetObjectClassAdmin(request.ClassId);
			var problems = new List<string>();
			if (request.Name != null && after.Name != request.Name.Trim())
				problems.Add($"name is \"{after.Name}\"");
			if (request.Workflow.HasValue && after.Workflow != request.Workflow.Value)
				problems.Add($"workflow is {after.Workflow}");
			if (request.NamePropertyDef.HasValue && after.NamePropertyDef != request.NamePropertyDef.Value)
				problems.Add($"name property is {after.NamePropertyDef}");
			List<KeyValuePair<int, bool>> savedList;
			string warning = null;
			if (loaded.FromRegularRead)
			{
				// The admin copy can't show the list, so check the regular read.
				// It can lag a moment behind the save, which isn't a failure:
				// the MCP server checks again over REST.
				var saved = WaitForRegularRead(vault, request.ClassId, desired, removals);
				savedList = saved.Associations;
				warning = saved.Problem;
			}
			else
			{
				savedList = Util.ReadAssociations(after.AssociatedPropertyDefs);
				var missing = desired.Where(d => !savedList.Contains(d)).ToList();
				if (missing.Count > 0)
					problems.Add($"missing {Util.Format(missing)}");
				var notRemoved = savedList.Where(s => removals.Contains(s.Key)).ToList();
				if (notRemoved.Count > 0)
					problems.Add($"still has {Util.Format(notRemoved)}");
			}
			if (problems.Count > 0)
				throw new InvalidOperationException(
					$"Class {request.ClassId} was saved but {string.Join(", ", problems)}. It now has {Util.Format(savedList)}; it should have {Util.Format(desired)}.");
			var types = new Dictionary<int, MFUpdateType>();
			return new { @class = Views.Class(after, savedList.Where(a => IsNormal(vault, a.Key, types)).ToList()), before, warning };
		}

		private sealed class SavedList
		{
			public List<KeyValuePair<int, bool>> Associations;
			public string Problem;
		}

		/// <summary>
		/// The class's properties from the regular read, re-read a few times
		/// until it shows the desired list. Problem says what's still off.
		/// </summary>
		private static readonly TimeSpan SavePatience = TimeSpan.FromSeconds(10);

		private static bool Shows(List<KeyValuePair<int, bool>> associations, List<KeyValuePair<int, bool>> desired, HashSet<int> removals)
		{
			return desired.All(associations.Contains) && !associations.Any(a => removals.Contains(a.Key));
		}

		private static SavedList WaitForRegularRead(Vault vault, int classId, List<KeyValuePair<int, bool>> desired, HashSet<int> removals)
		{
			var result = new SavedList();
			for (var attempt = 0; attempt < 4; attempt++)
			{
				if (attempt > 0)
					Thread.Sleep(1500);
				result.Associations = Util.ReadAssociations(vault.ClassOperations.GetObjectClass(classId).AssociatedPropertyDefs);
				var missing = desired.Where(d => !result.Associations.Contains(d)).ToList();
				var notRemoved = result.Associations.Where(s => removals.Contains(s.Key)).ToList();
				result.Problem = missing.Count == 0 && notRemoved.Count == 0
					? null
					: "The class was saved, but the vault's regular read doesn't show it yet: "
						+ string.Join(", ", new[]
						{
							missing.Count > 0 ? "missing " + Util.Format(missing) : null,
							notRemoved.Count > 0 ? "still has " + Util.Format(notRemoved) : null,
						}.Where(s => s != null))
						+ ".";
				if (result.Problem == null)
					break;
			}
			return result;
		}

		/// <summary>
		/// Builds the property list from fresh entries only. Entries taken from
		/// an existing collection are silently dropped by M-Files when added to a
		/// new one, which is how 1.0.3 and earlier lost a class's properties.
		/// </summary>
		private static AssociatedPropertyDefs BuildAssociations(List<KeyValuePair<int, bool>> desired, string what)
		{
			var list = new AssociatedPropertyDefs();
			foreach (var entry in desired)
				list.Add(-1, new AssociatedPropertyDef { PropertyDef = entry.Key, Required = entry.Value });
			var built = Util.ReadAssociations(list);
			if (!built.SequenceEqual(desired))
				throw new InvalidOperationException(
					$"Not saving {what}: the new property list came out as {Util.Format(built)} instead of {Util.Format(desired)}.");
			return list;
		}

		/// <summary>
		/// Reads the class for editing through the first channel and COM call
		/// whose copy matches the caller's (REST) view, directly or after taking
		/// the property list from the regular read. The admin session comes
		/// first; PermanentVault and its variants are fallbacks for when it
		/// can't be opened. Every attempt is recorded in reads.
		/// </summary>
		private static LoadedClass Load(JobContext context, int classId, ExpectedClassState expected, List<string> reads, bool stopAtMatch)
		{
			var updateTypes = new Dictionary<int, MFUpdateType>();
			LoadedClass match = null;
			foreach (var channel in Channels(context))
			{
				Vault vault;
				try
				{
					vault = channel.Value();
				}
				catch (Exception ex)
				{
					reads.Add($"{channel.Key}: unavailable: {Util.Describe(ex)}");
					continue;
				}
				if (vault == null)
				{
					reads.Add($"{channel.Key}: unavailable: {context.AdminError}");
					continue;
				}
				foreach (var path in ReadPaths(vault, classId))
				{
					try
					{
						var objectClass = path.Value();
						var adminList = Util.ReadAssociations(objectClass.AssociatedPropertyDefs);
						var settings = SettingDifferences(objectClass, expected);
						var properties = PropertyDifference(vault, adminList, expected, updateTypes);
						List<KeyValuePair<int, bool>> associations = null;
						var fromRegularRead = false;
						string outcome;
						if (settings.Count > 0)
						{
							outcome = string.Join("; ", properties == null ? settings : new[] { properties }.Concat(settings));
						}
						else if (properties == null)
						{
							associations = adminList;
							outcome = "matches";
						}
						else
						{
							string why;
							associations = FromRegularRead(vault, classId, objectClass, adminList, expected, updateTypes, out why);
							fromRegularRead = associations != null;
							outcome = associations != null
								? "matches after taking the property list from the regular read (" + why + ")"
								: properties + "; " + why;
						}
						reads.Add($"{channel.Key} {path.Key}: {outcome}");
						if (associations != null)
						{
							if (match == null)
								match = new LoadedClass
								{
									Channel = channel.Key + " " + path.Key + (fromRegularRead ? " + regular read" : ""),
									Vault = vault,
									Class = objectClass,
									Associations = associations,
									FromRegularRead = fromRegularRead,
								};
							if (stopAtMatch)
								return match;
							break;
						}
					}
					catch (Exception ex)
					{
						reads.Add($"{channel.Key} {path.Key}: failed: {Util.Describe(ex)}");
					}
				}
			}
			return match;
		}

		/// <summary>
		/// The class's user properties from the regular read, if it's safe to
		/// work from them: the regular read matches the caller's REST view, the
		/// admin copy only lacks entries, and the admin copy's permissions and
		/// aliases agree with the vault's. Otherwise null, with the reason.
		/// </summary>
		private static List<KeyValuePair<int, bool>> FromRegularRead(
			Vault vault, int classId, ObjectClassAdmin admin, List<KeyValuePair<int, bool>> adminList,
			ExpectedClassState expected, Dictionary<int, MFUpdateType> updateTypes, out string why)
		{
			var regular = vault.ClassOperations.GetObjectClass(classId);
			var regularList = Util.ReadAssociations(regular.AssociatedPropertyDefs);
			var userList = regularList.Where(a => IsNormal(vault, a.Key, updateTypes)).ToList();
			if (!new HashSet<int>(userList.Select(a => a.Key)).SetEquals(expected.Associations ?? new List<int>()))
			{
				why = $"the regular read has [{string.Join(", ", userList.Select(a => a.Key))}] too";
				return null;
			}
			var extra = adminList.Where(a => !regularList.Any(r => r.Key == a.Key)).ToList();
			if (extra.Count > 0)
			{
				why = $"the admin copy has {Util.Format(extra)}, which the regular read lacks";
				return null;
			}

			var problems = new List<string>();
			if (!SameAcl(admin.ACLForObjects, regular.ACLForObjects))
				problems.Add($"its object permissions ({DescribeAcl(admin.ACLForObjects)}) differ from the regular read's ({DescribeAcl(regular.ACLForObjects)})");
			if (!SameAutomaticPermissions(admin.AutomaticPermissionsForObjects, regular.AutomaticPermissionsForObjects))
				problems.Add("its automatic permissions differ from the regular read's");
			var adminAliases = Util.SplitAliases(admin.SemanticAliases);
			List<string> vaultAliases = null;
			try
			{
				vaultAliases = ClassAliases(vault, classId);
			}
			catch (Exception ex) when (Util.IsNotImplemented(ex))
			{
				// M-Files 25.11 doesn't implement the vault-wide alias map.
			}
			if (vaultAliases != null)
			{
				if (!new HashSet<string>(vaultAliases, StringComparer.OrdinalIgnoreCase).SetEquals(adminAliases))
					problems.Add($"its aliases [{string.Join(", ", adminAliases)}] differ from the vault's [{string.Join(", ", vaultAliases)}]");
			}
			else
			{
				// Without the map, check that every alias the admin copy has
				// points at this class. (Admin copies did return a new class's
				// aliases on 25.11; only the property list comes back short.)
				foreach (var alias in adminAliases)
				{
					var owner = Util.Attempt(() => vault.ClassOperations.GetObjectClassIDByAlias(alias).ToString());
					if (owner != classId.ToString())
						problems.Add($"its alias \"{alias}\" points at class {owner}");
				}
			}
			if (problems.Count > 0)
			{
				why = "the admin copy lacks properties and " + string.Join(", ", problems);
				return null;
			}
			why = $"the admin copy lists only {Util.Format(adminList)}; its permissions match the regular read's and its aliases {(vaultAliases != null ? "match the vault's" : "point at this class")}";
			return userList;
		}

		/// <summary>The same ACL, or one that grants exactly the same permissions.</summary>
		private static bool SameAcl(AccessControlList a, AccessControlList b)
		{
			if (a == null || b == null)
				return a == null && b == null;
			try
			{
				return a.EqualTo(b) || a.HasIdenticalPermissions(b);
			}
			catch
			{
				return false;
			}
		}

		private static string DescribeAcl(AccessControlList acl)
		{
			return acl == null
				? "none"
				: Util.Attempt(() => $"{acl.Count} entries, {acl.GetAsBytes().Length} bytes, fully authoritative {acl.IsFullyAuthoritative}");
		}

		private static bool SameAutomaticPermissions(AutomaticPermissions a, AutomaticPermissions b)
		{
			if (a == null || b == null)
				return a == null && b == null;
			return Util.Attempt(() => a.IsDefault + "|" + a.IsBasedOnObjectACL + "|" + a.CanDeactivate + "|" + (a.NamedACL?.ID ?? 0))
				== Util.Attempt(() => b.IsDefault + "|" + b.IsBasedOnObjectACL + "|" + b.CanDeactivate + "|" + (b.NamedACL?.ID ?? 0));
		}

		/// <summary>The class's aliases as the vault's alias map lists them.</summary>
		private static List<string> ClassAliases(Vault vault, int classId)
		{
			var aliases = new List<string>();
			var map = vault.GetMetadataStructureItemIDsByAliases(MFMetadataStructureItem.MFMetadataStructureItemClass, false);
			foreach (StructureAlias alias in map.Class)
			{
				if (alias.ID == classId)
					aliases.Add(alias.Alias);
			}
			return aliases;
		}

		private static IEnumerable<KeyValuePair<string, Func<Vault>>> Channels(JobContext context)
		{
			yield return new KeyValuePair<string, Func<Vault>>("admin session", () => context.TryAdmin());
			yield return new KeyValuePair<string, Func<Vault>>("PermanentVault", () => context.Permanent());
			yield return new KeyValuePair<string, Func<Vault>>("PermanentVault clone",
				() => Util.WithTimeout(() => context.Permanent().CloneForParallelActivity(), OpenTimeout, "vault clone"));
		}

		private static IEnumerable<KeyValuePair<string, Func<ObjectClassAdmin>>> ReadPaths(Vault vault, int classId)
		{
			yield return new KeyValuePair<string, Func<ObjectClassAdmin>>("GetObjectClassAdmin",
				() => vault.ClassOperations.GetObjectClassAdmin(classId));
			yield return new KeyValuePair<string, Func<ObjectClassAdmin>>("GetObjectClassesAdmin",
				() => FindClass(vault.ClassOperations.GetObjectClassesAdmin(
					vault.ClassOperations.GetObjectClass(classId).ObjectType), classId));
			yield return new KeyValuePair<string, Func<ObjectClassAdmin>>("GetAllObjectClassesAdmin",
				() => FindClass(vault.ClassOperations.GetAllObjectClassesAdmin(), classId));
		}

		private static ObjectClassAdmin FindClass(ObjectClassesAdmin classes, int classId)
		{
			foreach (ObjectClassAdmin objectClass in classes)
			{
				if (objectClass.ID == classId)
					return objectClass;
			}
			throw new InvalidOperationException($"Class {classId} is not in the list.");
		}

		private static bool IsNormal(Vault vault, int propertyId, Dictionary<int, MFUpdateType> updateTypes)
		{
			MFUpdateType updateType;
			if (!updateTypes.TryGetValue(propertyId, out updateType))
			{
				updateType = vault.PropertyDefOperations.GetPropertyDef(propertyId).UpdateType;
				updateTypes[propertyId] = updateType;
			}
			return updateType == MFUpdateType.MFUpdateTypeNormal;
		}

		/// <summary>
		/// How the copy's user properties differ from the caller's view, or null
		/// if they match. Built-in properties M-Files maintains itself are left
		/// out on both sides.
		/// </summary>
		private static string PropertyDifference(Vault vault, List<KeyValuePair<int, bool>> associations, ExpectedClassState expected, Dictionary<int, MFUpdateType> updateTypes)
		{
			var mine = associations.Select(a => a.Key).Where(id => IsNormal(vault, id, updateTypes)).ToList();
			var theirs = expected.Associations ?? new List<int>();
			return new HashSet<int>(mine).SetEquals(theirs)
				? null
				: $"properties [{string.Join(", ", mine)}] instead of [{string.Join(", ", theirs)}]";
		}

		/// <summary>How the copy's name, name property and workflow differ from the caller's view.</summary>
		private static List<string> SettingDifferences(ObjectClassAdmin objectClass, ExpectedClassState expected)
		{
			var differences = new List<string>();
			if (expected.Name != null && expected.Name != objectClass.Name)
				differences.Add($"name \"{objectClass.Name}\" instead of \"{expected.Name}\"");
			if (expected.NamePropertyDef.HasValue && expected.NamePropertyDef.Value != objectClass.NamePropertyDef)
				differences.Add($"name property {objectClass.NamePropertyDef} instead of {expected.NamePropertyDef.Value}");
			if (expected.Workflow.HasValue && expected.Workflow.Value != objectClass.Workflow)
				differences.Add($"workflow {objectClass.Workflow} instead of {expected.Workflow.Value}");
			if (expected.ForceWorkflow.HasValue && expected.ForceWorkflow.Value != objectClass.ForceWorkflow)
				differences.Add($"forced workflow {objectClass.ForceWorkflow} instead of {expected.ForceWorkflow.Value}");
			return differences;
		}
	}
}

using System;
using System.Collections.Generic;
using System.Linq;
using MFilesAPI;

namespace MFilesMCP.VaultApp
{
	internal static class ObjectTypeChanges
	{
		private static readonly TimeSpan SavePatience = TimeSpan.FromSeconds(10);

		/// <summary>
		/// Creates a real object type: one whose items are objects with
		/// metadata cards, unlike a value list. M-Files adds a property
		/// definition that refers to the new type, and usually a class of the
		/// same name; the result lists what it added.
		/// </summary>
		public static object Create(JobContext context, CreateObjectTypeRequest request)
		{
			var singular = Util.RequireText(request.NameSingular, "name_singular");
			var plural = string.IsNullOrWhiteSpace(request.NamePlural)
				? singular
				: request.NamePlural.Trim();

			var admin = new ObjTypeAdmin();
			if (admin.ObjectType == null)
				admin.ObjectType = new ObjType();
			var type = admin.ObjectType;
			type.NameSingular = singular;
			type.NamePlural = plural;
			type.RealObjectType = true;
			type.CanHaveFiles = request.CanHaveFiles;
			type.AllowAdding = request.AllowAdding ?? true;
			if (request.OwnerObjectType.HasValue)
			{
				type.HasOwnerType = true;
				type.OwnerType = request.OwnerObjectType.Value;
			}
			var aliases = Util.JoinAliases(request.Aliases);
			if (aliases.Length > 0)
			{
				if (admin.SemanticAliases == null)
					admin.SemanticAliases = new SemanticAliases();
				admin.SemanticAliases.Value = aliases;
			}

			var vault = context.AdminOrPermanent();
			var before = new HashSet<int>(AllTypes(vault).Select(t => t.ID));
			ObjTypeAdmin created = null;
			context.Step("creating the object type");
			Util.SaveAndConfirm(context,
				() => created = vault.ObjectTypeOperations.AddObjectTypeAdmin(admin),
				() => FindNew(vault, before, singular) != null,
				SavePatience);
			var id = created?.ObjectType.ID ?? FindNew(vault, before, singular).ID;

			context.Step("reading the new object type");
			var saved = vault.ObjectTypeOperations.GetObjectType(id);
			var classes = new List<object>();
			foreach (ObjectClass c in vault.ClassOperations.GetObjectClasses(id))
				classes.Add(new { id = c.ID, name = c.Name });
			return new
			{
				id = saved.ID,
				name_singular = saved.NameSingular,
				name_plural = saved.NamePlural,
				can_have_files = saved.CanHaveFiles,
				allow_adding = saved.AllowAdding,
				owner_object_type = saved.HasOwnerType ? (int?)saved.OwnerType : null,
				owner_property_def = saved.HasOwnerType ? (int?)saved.OwnerPropertyDef : null,
				default_property_def = saved.DefaultPropertyDef,
				classes,
			};
		}

		private static List<ObjType> AllTypes(Vault vault)
		{
			var list = new List<ObjType>();
			foreach (ObjType t in vault.ObjectTypeOperations.GetObjectTypes())
				list.Add(t);
			return list;
		}

		/// <summary>The type with this name that wasn't there before the save, if it shows yet.</summary>
		private static ObjType FindNew(Vault vault, HashSet<int> before, string name)
		{
			return AllTypes(vault).FirstOrDefault(t =>
				!before.Contains(t.ID) && string.Equals(t.NameSingular, name, StringComparison.OrdinalIgnoreCase));
		}
	}
}

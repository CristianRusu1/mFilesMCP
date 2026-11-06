using System;
using System.Collections.Generic;
using MFilesAPI;

namespace MFilesMCP.VaultApp
{
	internal static class ValueListChanges
	{
		public static object Create(JobContext context, CreateValueListRequest request)
		{
			var singular = Util.RequireText(request.NameSingular, "name_singular");
			var plural = string.IsNullOrWhiteSpace(request.NamePlural)
				? singular
				: request.NamePlural.Trim();

			var admin = new ObjTypeAdmin();
			if (admin.ObjectType == null)
				admin.ObjectType = new ObjType();
			admin.ObjectType.NameSingular = singular;
			admin.ObjectType.NamePlural = plural;
			admin.ObjectType.RealObjectType = false;
			var aliases = Util.JoinAliases(request.Aliases);
			if (aliases.Length > 0)
			{
				if (admin.SemanticAliases == null)
					admin.SemanticAliases = new SemanticAliases();
				admin.SemanticAliases.Value = aliases;
			}

			var vault = context.AdminOrPermanent();
			context.Step("creating the value list");
			var created = vault.ValueListOperations.AddValueListAdmin(admin).ObjectType;

			// Items are added one by one, so a bad item doesn't hide that the
			// list exists.
			context.Step("adding items");
			var items = new List<object>();
			var failedItems = new List<object>();
			foreach (var raw in request.Items ?? new List<string>())
			{
				var itemName = raw?.Trim();
				if (string.IsNullOrEmpty(itemName))
					continue;
				try
				{
					var item = new ValueListItem { Name = itemName, ValueListID = created.ID };
					var added = vault.ValueListItemOperations.AddValueListItem(created.ID, item, true);
					items.Add(new { id = added.ID, name = added.Name });
				}
				catch (Exception ex)
				{
					failedItems.Add(new { name = itemName, error = Util.Describe(ex) });
				}
			}
			return new
			{
				id = created.ID,
				name_singular = created.NameSingular,
				name_plural = created.NamePlural,
				items,
				failed_items = failedItems,
			};
		}
	}
}

using System;
using System.Collections.Generic;
using MFilesAPI;

namespace MFilesMCP.VaultApp
{
	internal static class PropertyDefChanges
	{
		private static readonly HashSet<MFDataType> CreatableDataTypes = new HashSet<MFDataType>
		{
			MFDataType.MFDatatypeText,
			MFDataType.MFDatatypeMultiLineText,
			MFDataType.MFDatatypeInteger,
			MFDataType.MFDatatypeFloating,
			MFDataType.MFDatatypeDate,
			MFDataType.MFDatatypeTime,
			MFDataType.MFDatatypeTimestamp,
			MFDataType.MFDatatypeBoolean,
			MFDataType.MFDatatypeLookup,
			MFDataType.MFDatatypeMultiSelectLookup,
		};

		public static object Read(JobContext context, int propertyId)
		{
			return Views.PropertyDef(context.Admin().PropertyDefOperations.GetPropertyDefAdmin(propertyId));
		}

		/// <summary>Checks the input before the job is queued, so mistakes come back at once.</summary>
		public static void Validate(CreatePropertyDefRequest request)
		{
			Util.RequireText(request.Name, "name");
			var dataType = (MFDataType)request.DataType;
			if (!CreatableDataTypes.Contains(dataType))
				throw new ArgumentException($"data_type {request.DataType} can't be used for a new property definition.");
			var isLookup = dataType == MFDataType.MFDatatypeLookup
				|| dataType == MFDataType.MFDatatypeMultiSelectLookup;
			if (isLookup != request.ValueList.HasValue)
				throw new ArgumentException(isLookup
					? "value_list is required for lookup properties."
					: "value_list only applies to lookup properties.");
			if (!request.AllObjectTypes && !request.ObjectType.HasValue)
				throw new ArgumentException("Pass object_type or all_object_types.");
		}

		public static object Create(JobContext context, CreatePropertyDefRequest request)
		{
			var dataType = (MFDataType)request.DataType;
			var admin = new PropertyDefAdmin();
			if (admin.PropertyDef == null)
				admin.PropertyDef = new PropertyDef();
			var def = admin.PropertyDef;
			def.Name = request.Name.Trim();
			def.DataType = dataType;
			def.AllObjectTypes = request.AllObjectTypes;
			if (!request.AllObjectTypes)
				def.ObjectType = request.ObjectType.Value;
			if (request.ValueList.HasValue)
			{
				def.BasedOnValueList = true;
				def.ValueList = request.ValueList.Value;
			}
			var aliases = Util.JoinAliases(request.Aliases);
			if (aliases.Length > 0)
			{
				if (admin.SemanticAliases == null)
					admin.SemanticAliases = new SemanticAliases();
				admin.SemanticAliases.Value = aliases;
			}

			var vault = context.AdminOrPermanent();
			context.Step("creating the property definition");
			var created = vault.PropertyDefOperations.AddPropertyDefAdmin(admin).PropertyDef;
			return new
			{
				id = created.ID,
				name = created.Name,
				data_type = (int)created.DataType,
				value_list = created.BasedOnValueList ? (int?)created.ValueList : null,
				object_type = created.AllObjectTypes ? (int?)null : created.ObjectType,
				all_object_types = created.AllObjectTypes,
			};
		}

		public static void Validate(UpdatePropertyDefRequest request)
		{
			if (request.Name != null)
				Util.RequireText(request.Name, "name");
			if (request.AutomaticValue != null)
				AutomaticValueType(request.AutomaticValue);
			if (request.Validation != null)
				ValidationType(request.Validation);
			RecalculateMode(request.Recalculate);
		}

		public static object Update(JobContext context, UpdatePropertyDefRequest request)
		{
			var vault = context.Admin();
			context.Step("reading the property definition");
			var admin = vault.PropertyDefOperations.GetPropertyDefAdmin(request.PropertyId);
			var def = admin.PropertyDef;
			var expected = request.Expected;
			var differences = new List<string>();
			if (def.Name != expected.Name)
				differences.Add($"name \"{def.Name}\" instead of \"{expected.Name}\"");
			if ((int)def.DataType != expected.DataType)
				differences.Add($"data type {(int)def.DataType} instead of {expected.DataType}");
			if (expected.ValueList.HasValue && (!def.BasedOnValueList || def.ValueList != expected.ValueList.Value))
				differences.Add($"value list {(def.BasedOnValueList ? def.ValueList.ToString() : "none")} instead of {expected.ValueList.Value}");
			if (differences.Count > 0)
				throw new InvalidOperationException(
					$"Not saving property {request.PropertyId}: the admin session's copy has {string.Join(" and ", differences)}. Nothing was changed.");
			var before = Views.PropertyDef(admin);

			if (request.Name != null)
				def.Name = request.Name.Trim();
			if (request.AddAliases != null || request.RemoveAliases != null)
			{
				var merged = Util.MergeAliases(admin.SemanticAliases, request.AddAliases, request.RemoveAliases);
				if (admin.SemanticAliases == null)
					admin.SemanticAliases = new SemanticAliases();
				admin.SemanticAliases.Value = merged;
			}
			if (request.AutomaticValue != null)
				ApplyAutomaticValue(admin, request.AutomaticValue);
			if (request.Validation != null)
				ApplyValidation(admin, request.Validation);

			context.Step("saving the property definition");
			vault.PropertyDefOperations.UpdatePropertyDefAdmin(admin);
			var recalculate = RecalculateMode(request.Recalculate);
			if (recalculate.HasValue)
			{
				context.Step("recalculating values");
				vault.PropertyDefOperations.Recalculate(request.PropertyId, recalculate.Value);
			}

			context.Step("checking the saved property definition");
			var after = vault.PropertyDefOperations.GetPropertyDefAdmin(request.PropertyId);
			var problems = new List<string>();
			if (request.Name != null && after.PropertyDef.Name != request.Name.Trim())
				problems.Add($"name is \"{after.PropertyDef.Name}\"");
			if (request.AutomaticValue != null && Views.AutomaticValueTypeName(after.PropertyDef.AutomaticValueType) != request.AutomaticValue.Type.Trim().ToLowerInvariant())
				problems.Add($"automatic value is {Views.AutomaticValueTypeName(after.PropertyDef.AutomaticValueType)}");
			if (request.Validation != null && Views.ValidationTypeName(after.PropertyDef.ValidationType) != request.Validation.Type.Trim().ToLowerInvariant())
				problems.Add($"validation is {Views.ValidationTypeName(after.PropertyDef.ValidationType)}");
			if (problems.Count > 0)
				throw new InvalidOperationException($"Property {request.PropertyId} was saved but {string.Join(", ", problems)}.");
			return new { property_def = Views.PropertyDef(after), before };
		}

		private static MFAutomaticValueType AutomaticValueType(AutomaticValueRequest request)
		{
			switch (Util.RequireText(request.Type, "automatic_value.type").ToLowerInvariant())
			{
				case "none":
					return MFAutomaticValueType.MFAutomaticValueTypeNone;
				case "calculated":
					Util.RequireText(request.Expression, "automatic_value.expression");
					return MFAutomaticValueType.MFAutomaticValueTypeCalculatedWithPlaceholders;
				case "calculated_vbscript":
					Util.RequireText(request.Script, "automatic_value.script");
					return MFAutomaticValueType.MFAutomaticValueTypeCalculatedWithVBScript;
				case "auto_number":
					return MFAutomaticValueType.MFAutomaticValueTypeAutoNumberSimple;
				case "auto_number_vbscript":
					Util.RequireText(request.Script, "automatic_value.script");
					return MFAutomaticValueType.MFAutomaticValueTypeWithVBScript;
				default:
					throw new ArgumentException(
						$"automatic_value.type \"{request.Type}\" isn't one of none, calculated, calculated_vbscript, auto_number, auto_number_vbscript.");
			}
		}

		private static void ApplyAutomaticValue(PropertyDefAdmin admin, AutomaticValueRequest request)
		{
			var type = AutomaticValueType(request);
			var value = admin.AutomaticValue ?? new AutomaticValue();
			admin.PropertyDef.AutomaticValueType = type;
			switch (type)
			{
				case MFAutomaticValueType.MFAutomaticValueTypeCalculatedWithPlaceholders:
					value.CVSExpression = request.Expression;
					break;
				case MFAutomaticValueType.MFAutomaticValueTypeCalculatedWithVBScript:
					value.CVVCode = request.Script;
					break;
				case MFAutomaticValueType.MFAutomaticValueTypeAutoNumberSimple:
					value.ANSIncrement = request.Increment ?? 1;
					break;
				case MFAutomaticValueType.MFAutomaticValueTypeWithVBScript:
					value.ANVCode = request.Script;
					break;
			}
			if (request.CalculationOrder.HasValue)
				value.CalculationOrderNumber = request.CalculationOrder.Value;
			admin.AutomaticValue = value;
		}

		private static MFValidationType ValidationType(ValidationRequest request)
		{
			switch (Util.RequireText(request.Type, "validation.type").ToLowerInvariant())
			{
				case "none":
					return MFValidationType.MFValidationTypeNone;
				case "regex":
					Util.RequireText(request.Regex, "validation.regex");
					return MFValidationType.MFValidationTypeRegularExpression;
				case "vbscript":
					Util.RequireText(request.Script, "validation.script");
					return MFValidationType.MFValidationTypeVBScript;
				default:
					throw new ArgumentException($"validation.type \"{request.Type}\" isn't one of none, regex, vbscript.");
			}
		}

		private static void ApplyValidation(PropertyDefAdmin admin, ValidationRequest request)
		{
			var type = ValidationType(request);
			var validation = admin.Validation ?? new Validation();
			admin.PropertyDef.ValidationType = type;
			if (type == MFValidationType.MFValidationTypeRegularExpression)
				validation.RegularExpression = request.Regex;
			if (type == MFValidationType.MFValidationTypeVBScript)
				validation.VBScript = request.Script;
			admin.Validation = validation;
		}

		/// <summary>null for no recalculation, else whether to recalculate only empty values.</summary>
		private static bool? RecalculateMode(string mode)
		{
			switch ((mode ?? "none").Trim().ToLowerInvariant())
			{
				case "none":
				case "":
					return null;
				case "empty_only":
					return true;
				case "all":
					return false;
				default:
					throw new ArgumentException($"recalculate \"{mode}\" isn't one of none, empty_only, all.");
			}
		}
	}
}

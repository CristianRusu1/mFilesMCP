using System.Collections.Generic;
using System.Linq;
using MFilesAPI;
using MFEventHandler = MFilesAPI.EventHandler;

namespace MFilesMCP.VaultApp
{
	/// <summary>
	/// JSON shapes of admin objects. Every value is copied out when the view is
	/// built, so a view taken before a change still shows the old values.
	/// </summary>
	internal static class Views
	{
		/// <param name="associations">The class's properties, when they come from somewhere other than the admin copy.</param>
		public static object Class(ObjectClassAdmin c, List<KeyValuePair<int, bool>> associations = null)
		{
			return new
			{
				id = c.ID,
				name = c.Name,
				object_type = c.ObjectType,
				name_property_def = c.NamePropertyDef,
				workflow = c.Workflow == 0 ? (int?)null : c.Workflow,
				force_workflow = c.ForceWorkflow,
				predefined = c.Predefined,
				aliases = Util.SplitAliases(c.SemanticAliases),
				associated_property_defs = (associations ?? Util.ReadAssociations(c.AssociatedPropertyDefs))
					.Select(a => new { property_id = a.Key, required = a.Value })
					.ToList(),
			};
		}

		public static object Workflow(WorkflowAdmin w)
		{
			return new
			{
				id = w.Workflow.ID,
				name = w.Workflow.Name,
				object_class = w.Workflow.ObjectClass == 0 ? (int?)null : w.Workflow.ObjectClass,
				description = Util.NullIfEmpty(w.Description),
				aliases = Util.SplitAliases(w.SemanticAliases),
				states = States(w).Select(State).ToList(),
				transitions = Transitions(w).Select(Transition).ToList(),
			};
		}

		public static List<StateAdmin> States(WorkflowAdmin w)
		{
			var list = new List<StateAdmin>();
			if (w.States != null)
			{
				foreach (StateAdmin s in w.States)
					list.Add(s);
			}
			return list;
		}

		public static List<StateTransition> Transitions(WorkflowAdmin w)
		{
			var list = new List<StateTransition>();
			if (w.StateTransitions != null)
			{
				foreach (StateTransition t in w.StateTransitions)
					list.Add(t);
			}
			return list;
		}

		public static object State(StateAdmin s)
		{
			return new
			{
				id = s.ID,
				name = s.Name,
				description = Util.NullIfEmpty(s.Description),
				aliases = Util.SplitAliases(s.SemanticAliases),
				run_script = s.ActionRunVBScript,
				script = Util.NullIfEmpty(s.ActionRunVBScriptDefinition),
				preconditions = Conditions(s.Preconditions),
				postconditions = Conditions(s.Postconditions),
				actions = Actions(s),
				restrict_transitions = s.RestrictTransitions,
			};
		}

		private static object Conditions(StateConditions c)
		{
			if (c == null || (!c.VBScript && !c.PropertyConditions && string.IsNullOrEmpty(c.VBScriptDefinition)))
				return null;
			return new
			{
				script_enabled = c.VBScript,
				script = Util.NullIfEmpty(c.VBScriptDefinition),
				property_conditions = c.PropertyConditions,
			};
		}

		/// <summary>The state actions that are switched on. Only scripts can be edited through the app.</summary>
		private static List<string> Actions(StateAdmin s)
		{
			var actions = new List<string>();
			if (s.ActionRunVBScript) actions.Add("run_script");
			if (s.ActionSetProperties) actions.Add("set_properties");
			if (s.ActionSetPermissions) actions.Add("set_permissions");
			if (s.ActionAssignToUser) actions.Add("assign_to_user");
			if (s.ActionCreateSeparateAssignment) actions.Add("create_separate_assignment");
			if (s.ActionSendNotification) actions.Add("send_notification");
			if (s.ActionConvertToPDF) actions.Add("convert_to_pdf");
			if (s.ActionMarkForArchiving) actions.Add("mark_for_archiving");
			if (s.ActionDelete) actions.Add("delete");
			return actions;
		}

		public static object Transition(StateTransition t)
		{
			return new
			{
				id = t.ID,
				name = Util.NullIfEmpty(t.Name),
				description = Util.NullIfEmpty(t.Description),
				from_state = t.FromState,
				to_state = t.ToState,
				trigger = TriggerName(t.TriggerMode),
				trigger_in_days = t.TriggerMode == MFAutoStateTransitionMode.MFASTModeRelativeTime ? (int?)t.TriggerInDays : null,
				trigger_script = Util.NullIfEmpty(t.TriggerAllowedByVBScript),
				evaluation_order = t.EvaluationOrderNumber,
				aliases = Util.SplitAliases(t.SemanticAliases),
			};
		}

		public static string TriggerName(MFAutoStateTransitionMode mode)
		{
			switch (mode)
			{
				case MFAutoStateTransitionMode.MFASTModeNone: return "none";
				case MFAutoStateTransitionMode.MFASTModeRelativeTime: return "days";
				case MFAutoStateTransitionMode.MFASTModeAssignmentCompleteOne: return "assignment_complete_one";
				case MFAutoStateTransitionMode.MFASTModeAssignmentCompleteAll: return "assignment_complete_all";
				case MFAutoStateTransitionMode.MFASTModeCriteriaFulfilled: return "criteria";
				case MFAutoStateTransitionMode.MFASTModeAllowedByScript: return "script";
				case MFAutoStateTransitionMode.MFASTModeAssignmentComplete: return "assignment_complete";
				case MFAutoStateTransitionMode.MFASTModeAssignmentRejected: return "assignment_rejected";
				default: return ((int)mode).ToString();
			}
		}

		public static object Handler(MFEventHandler h, int position)
		{
			return new
			{
				guid = h.GUID,
				position,
				event_type = EventTypeName(h.EventType),
				event_type_id = (int)h.EventType,
				name = h.Description,
				active = h.Active,
				generated_by_app = GeneratedBy(h.VBScript),
				script = h.VBScript,
			};
		}

		private const string Guid = @"([0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12})";

		private static readonly System.Text.RegularExpressions.Regex GeneratedMarker =
			new System.Text.RegularExpressions.Regex("GENERATED_SCRIPT_START_" + Guid);

		private static readonly System.Text.RegularExpressions.Regex ExtensionObject =
			new System.Text.RegularExpressions.Regex(@"GetExtensionObject\(\s*""[^""]*""\s*,\s*""" + Guid + @"""\s*\)");

		/// <summary>
		/// The vault application that generated this handler, if any. M-Files
		/// writes stub handlers that hand events and extension methods over to
		/// vault apps. They say "DO NOT MODIFY", and either carry a
		/// GENERATED_SCRIPT_START_ marker or call GetExtensionObject with the
		/// app's GUID.
		/// </summary>
		public static string GeneratedBy(string script)
		{
			var text = script ?? "";
			var match = GeneratedMarker.Match(text);
			if (match.Success)
				return match.Groups[1].Value;
			if (text.IndexOf("DO NOT MODIFY", System.StringComparison.OrdinalIgnoreCase) < 0)
				return null;
			match = ExtensionObject.Match(text);
			return match.Success ? match.Groups[1].Value : null;
		}

		public static string EventTypeName(MFEventHandlerType type)
		{
			return Util.EnumName(type, "MFEventHandler");
		}

		public static object PropertyDef(PropertyDefAdmin p)
		{
			var d = p.PropertyDef;
			return new
			{
				id = d.ID,
				name = d.Name,
				data_type = (int)d.DataType,
				value_list = d.BasedOnValueList ? (int?)d.ValueList : null,
				object_type = d.AllObjectTypes ? (int?)null : d.ObjectType,
				all_object_types = d.AllObjectTypes,
				predefined = d.Predefined,
				update_type = (int)d.UpdateType,
				aliases = Util.SplitAliases(p.SemanticAliases),
				automatic_value = AutomaticValue(d, p.AutomaticValue),
				validation = Validation(d, p.Validation),
			};
		}

		public static string AutomaticValueTypeName(MFAutomaticValueType type)
		{
			switch (type)
			{
				case MFAutomaticValueType.MFAutomaticValueTypeNone: return "none";
				case MFAutomaticValueType.MFAutomaticValueTypeCalculatedWithPlaceholders: return "calculated";
				case MFAutomaticValueType.MFAutomaticValueTypeCalculatedWithVBScript: return "calculated_vbscript";
				case MFAutomaticValueType.MFAutomaticValueTypeAutoNumberSimple: return "auto_number";
				case MFAutomaticValueType.MFAutomaticValueTypeWithVBScript: return "auto_number_vbscript";
				default: return ((int)type).ToString();
			}
		}

		private static object AutomaticValue(PropertyDef d, AutomaticValue a)
		{
			var type = d.AutomaticValueType;
			return new
			{
				type = AutomaticValueTypeName(type),
				expression = type == MFAutomaticValueType.MFAutomaticValueTypeCalculatedWithPlaceholders ? Util.NullIfEmpty(a?.CVSExpression) : null,
				script = type == MFAutomaticValueType.MFAutomaticValueTypeCalculatedWithVBScript ? Util.NullIfEmpty(a?.CVVCode)
					: type == MFAutomaticValueType.MFAutomaticValueTypeWithVBScript ? Util.NullIfEmpty(a?.ANVCode)
					: null,
				increment = type == MFAutomaticValueType.MFAutomaticValueTypeAutoNumberSimple ? a?.ANSIncrement : null,
				calculation_order = type == MFAutomaticValueType.MFAutomaticValueTypeNone ? null : a?.CalculationOrderNumber,
			};
		}

		public static string ValidationTypeName(MFValidationType type)
		{
			switch (type)
			{
				case MFValidationType.MFValidationTypeNone: return "none";
				case MFValidationType.MFValidationTypeRegularExpression: return "regex";
				case MFValidationType.MFValidationTypeVBScript: return "vbscript";
				default: return ((int)type).ToString();
			}
		}

		private static object Validation(PropertyDef d, Validation v)
		{
			var type = d.ValidationType;
			return new
			{
				type = ValidationTypeName(type),
				regex = type == MFValidationType.MFValidationTypeRegularExpression ? Util.NullIfEmpty(v?.RegularExpression) : null,
				script = type == MFValidationType.MFValidationTypeVBScript ? Util.NullIfEmpty(v?.VBScript) : null,
			};
		}
	}
}

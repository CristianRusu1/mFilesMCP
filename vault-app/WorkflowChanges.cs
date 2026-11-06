using System;
using System.Collections.Generic;
using System.Linq;
using MFilesAPI;

namespace MFilesMCP.VaultApp
{
	/// <summary>
	/// Workflow reads and changes. All of them go through the admin session:
	/// a workflow's scripts and actions can't be checked against REST, so a
	/// copy from a session that might read it incompletely is never saved.
	/// </summary>
	internal static class WorkflowChanges
	{
		public static object Read(JobContext context, int workflowId)
		{
			return Views.Workflow(context.Admin().WorkflowOperations.GetWorkflowAdmin(workflowId));
		}

		public static object Create(JobContext context, CreateWorkflowRequest request)
		{
			var name = Util.RequireText(request.Name, "name");
			var states = request.States ?? new List<StateRequest>();
			if (states.Count == 0)
				throw new ArgumentException("A workflow needs at least one state.");
			RequireUniqueNames(states.Select(s => Util.RequireText(s.Name, "states[].name")), Enumerable.Empty<string>());
			var vault = context.Admin();

			var workflow = new WorkflowAdmin();
			if (workflow.Workflow == null)
				workflow.Workflow = new Workflow();
			workflow.Workflow.Name = name;
			if (request.Description != null)
				workflow.Description = request.Description;
			SetAliases(workflow, request.Aliases);
			var newStates = new StatesAdmin();
			foreach (var s in states)
				newStates.Add(-1, NewState(s));
			workflow.States = newStates;
			workflow.StateTransitions = new StateTransitions();

			context.Step("creating the workflow");
			var created = vault.WorkflowOperations.AddWorkflowAdmin(workflow);
			var id = created.Workflow.ID;
			context.Diagnostics["workflow_id"] = id;

			// Transitions refer to states by ID, which new states only get once
			// the workflow is saved, so they go in a second save.
			var transitions = request.Transitions ?? new List<TransitionRequest>();
			if (transitions.Count > 0)
			{
				context.Step("adding transitions");
				var current = vault.WorkflowOperations.GetWorkflowAdmin(id);
				if (current.StateTransitions == null)
					current.StateTransitions = new StateTransitions();
				foreach (var t in transitions)
					current.StateTransitions.Add(-1, NewTransition(t, current));
				try
				{
					vault.WorkflowOperations.UpdateWorkflowAdmin(current);
				}
				catch (Exception ex)
				{
					throw new InvalidOperationException(
						$"Workflow {id} (\"{name}\") was created with its states, but adding the transitions failed: {Util.Describe(ex)} Add them with an update.");
				}
			}

			var after = vault.WorkflowOperations.GetWorkflowAdmin(id);
			var problems = new List<string>();
			var savedStates = Views.States(after);
			foreach (var s in states)
			{
				if (!savedStates.Any(x => SameName(x.Name, s.Name)))
					problems.Add($"state \"{s.Name}\" is missing");
			}
			var savedTransitions = Views.Transitions(after);
			if (savedTransitions.Count < transitions.Count)
				problems.Add($"{savedTransitions.Count} transitions instead of {transitions.Count}");
			if (problems.Count > 0)
				throw new InvalidOperationException($"Workflow {id} was saved but {string.Join(", ", problems)}.");
			return Views.Workflow(after);
		}

		public static object Update(JobContext context, UpdateWorkflowRequest request)
		{
			var vault = context.Admin();
			var id = request.WorkflowId;
			context.Step("reading the workflow");
			var workflow = vault.WorkflowOperations.GetWorkflowAdmin(id);
			CheckExpected(workflow, request.Expected);

			var beforeStateIds = Views.States(workflow).Select(s => s.ID).ToList();
			var beforeTransitionIds = Views.Transitions(workflow).Select(t => t.ID).ToList();
			var previousStates = new List<object>();
			var previousTransitions = new List<object>();

			if (request.Name != null)
				workflow.Workflow.Name = Util.RequireText(request.Name, "name");
			if (request.Description != null)
				workflow.Description = request.Description;

			foreach (var u in request.UpdateStates ?? new List<StateUpdateRequest>())
			{
				var state = FindState(workflow, u.Id);
				previousStates.Add(Views.State(state));
				if (u.Name != null)
					state.Name = Util.RequireText(u.Name, "update_states[].name");
				if (u.Description != null)
					state.Description = u.Description;
				ApplyScripts(state, u);
			}

			var removals = new HashSet<int>(request.RemoveTransitions ?? new List<int>());
			foreach (var transitionId in removals)
				previousTransitions.Add(Views.Transition(FindTransition(workflow, transitionId)));
			for (var i = workflow.StateTransitions?.Count ?? 0; i >= 1; i--)
			{
				if (removals.Contains(workflow.StateTransitions[i].ID))
					workflow.StateTransitions.Remove(i);
			}
			var remaining = Views.Transitions(workflow).Select(t => t.ID).ToList();
			var shouldRemain = beforeTransitionIds.Where(t => !removals.Contains(t)).ToList();
			if (!new HashSet<int>(remaining).SetEquals(shouldRemain))
				throw new InvalidOperationException(
					$"Not saving workflow {id}: removing transitions left [{string.Join(", ", remaining)}] instead of [{string.Join(", ", shouldRemain)}]. Nothing was changed.");

			foreach (var u in request.UpdateTransitions ?? new List<TransitionUpdateRequest>())
			{
				if (removals.Contains(u.Id))
					throw new ArgumentException($"Transition {u.Id} is both updated and removed.");
				var transition = FindTransition(workflow, u.Id);
				previousTransitions.Add(Views.Transition(transition));
				if (u.FromState.HasValue)
					transition.FromState = ResolveState(workflow, u.FromState, null, "update_transitions[].from_state");
				if (u.ToState.HasValue)
					transition.ToState = ResolveState(workflow, u.ToState, null, "update_transitions[].to_state");
				if (u.Name != null)
					transition.Name = u.Name;
				if (u.Description != null)
					transition.Description = u.Description;
				if (u.Trigger != null)
					ApplyTrigger(transition, u.Trigger);
			}

			var addStates = request.AddStates ?? new List<StateRequest>();
			RequireUniqueNames(addStates.Select(s => Util.RequireText(s.Name, "add_states[].name")), Views.States(workflow).Select(s => s.Name));
			if (workflow.States == null)
				workflow.States = new StatesAdmin();
			foreach (var s in addStates)
				workflow.States.Add(-1, NewState(s));

			// Transitions to or from new states need their IDs, which M-Files
			// assigns on save; so save the states first and read them back.
			var addTransitions = request.AddTransitions ?? new List<TransitionRequest>();
			if (addStates.Count > 0 && addTransitions.Count > 0)
			{
				context.Step("saving the new states");
				vault.WorkflowOperations.UpdateWorkflowAdmin(workflow);
				workflow = vault.WorkflowOperations.GetWorkflowAdmin(id);
			}
			if (addTransitions.Count > 0)
			{
				if (workflow.StateTransitions == null)
					workflow.StateTransitions = new StateTransitions();
				foreach (var t in addTransitions)
					workflow.StateTransitions.Add(-1, NewTransition(t, workflow));
			}
			context.Step("saving the workflow");
			vault.WorkflowOperations.UpdateWorkflowAdmin(workflow);

			context.Step("checking the saved workflow");
			var after = vault.WorkflowOperations.GetWorkflowAdmin(id);
			var problems = new List<string>();
			var savedStates = Views.States(after);
			var savedTransitions = Views.Transitions(after);
			var lostStates = beforeStateIds.Where(s => !savedStates.Any(x => x.ID == s)).ToList();
			if (lostStates.Count > 0)
				problems.Add($"states {string.Join(", ", lostStates)} are gone");
			foreach (var s in addStates)
			{
				if (!savedStates.Any(x => SameName(x.Name, s.Name)))
					problems.Add($"new state \"{s.Name}\" is missing");
			}
			foreach (var u in request.UpdateStates ?? new List<StateUpdateRequest>())
			{
				var saved = savedStates.FirstOrDefault(x => x.ID == u.Id);
				if (saved == null)
					continue;
				if (u.Script != null && (saved.ActionRunVBScriptDefinition ?? "") != u.Script)
					problems.Add($"state {u.Id}'s script didn't save");
				if (u.PreconditionsScript != null && (saved.Preconditions?.VBScriptDefinition ?? "") != u.PreconditionsScript)
					problems.Add($"state {u.Id}'s preconditions script didn't save");
				if (u.PostconditionsScript != null && (saved.Postconditions?.VBScriptDefinition ?? "") != u.PostconditionsScript)
					problems.Add($"state {u.Id}'s postconditions script didn't save");
			}
			var lostTransitions = beforeTransitionIds.Where(t => !removals.Contains(t) && !savedTransitions.Any(x => x.ID == t)).ToList();
			if (lostTransitions.Count > 0)
				problems.Add($"transitions {string.Join(", ", lostTransitions)} are gone");
			var expectedCount = beforeTransitionIds.Count - removals.Count + addTransitions.Count;
			if (savedTransitions.Count != expectedCount)
				problems.Add($"{savedTransitions.Count} transitions instead of {expectedCount}");
			if (problems.Count > 0)
				throw new InvalidOperationException($"Workflow {id} was saved but {string.Join(", ", problems)}.");

			return new
			{
				workflow = Views.Workflow(after),
				previous = new { states = previousStates, transitions = previousTransitions },
			};
		}

		/// <summary>
		/// Refuses to work from a copy that differs from what the caller sees
		/// over REST: a different name, or other states.
		/// </summary>
		private static void CheckExpected(WorkflowAdmin workflow, ExpectedWorkflow expected)
		{
			var mine = Views.States(workflow).Select(s => s.ID).ToList();
			var differences = new List<string>();
			if (!new HashSet<int>(mine).SetEquals(expected.States ?? new List<int>()))
				differences.Add($"states [{string.Join(", ", mine)}] instead of [{string.Join(", ", expected.States ?? new List<int>())}]");
			if (expected.Name != null && expected.Name != workflow.Workflow.Name)
				differences.Add($"name \"{workflow.Workflow.Name}\" instead of \"{expected.Name}\"");
			if (differences.Count > 0)
				throw new InvalidOperationException(
					$"Not saving workflow {workflow.Workflow.ID}: the admin session's copy has {string.Join(" and ", differences)}. Nothing was changed.");
		}

		private static StateAdmin NewState(StateRequest request)
		{
			var state = new StateAdmin();
			state.Name = request.Name.Trim();
			if (request.Description != null)
				state.Description = request.Description;
			ApplyScripts(state, request);
			var aliases = Util.JoinAliases(request.Aliases);
			if (aliases.Length > 0)
			{
				if (state.SemanticAliases == null)
					state.SemanticAliases = new SemanticAliases();
				state.SemanticAliases.Value = aliases;
			}
			return state;
		}

		/// <summary>A script string switches that script on; an empty one switches it off.</summary>
		private static void ApplyScripts(StateAdmin state, StateScripts scripts)
		{
			if (scripts.Script != null)
			{
				state.ActionRunVBScript = scripts.Script.Length > 0;
				state.ActionRunVBScriptDefinition = scripts.Script;
			}
			if (scripts.PreconditionsScript != null)
				state.Preconditions = WithScript(state.Preconditions, scripts.PreconditionsScript);
			if (scripts.PostconditionsScript != null)
				state.Postconditions = WithScript(state.Postconditions, scripts.PostconditionsScript);
		}

		private static StateConditions WithScript(StateConditions conditions, string script)
		{
			var result = conditions ?? new StateConditions();
			result.VBScript = script.Length > 0;
			result.VBScriptDefinition = script;
			return result;
		}

		private static StateTransition NewTransition(TransitionRequest request, WorkflowAdmin workflow)
		{
			var transition = new StateTransition();
			transition.FromState = ResolveState(workflow, request.FromState, request.FromStateName, "from_state");
			transition.ToState = ResolveState(workflow, request.ToState, request.ToStateName, "to_state");
			if (request.Name != null)
				transition.Name = request.Name;
			if (request.Description != null)
				transition.Description = request.Description;
			if (request.Trigger != null)
				ApplyTrigger(transition, request.Trigger);
			return transition;
		}

		private static void ApplyTrigger(StateTransition transition, TriggerRequest trigger)
		{
			var mode = Util.RequireText(trigger.Mode, "trigger.mode").ToLowerInvariant();
			switch (mode)
			{
				case "none":
					transition.TriggerMode = MFAutoStateTransitionMode.MFASTModeNone;
					break;
				case "script":
					transition.TriggerMode = MFAutoStateTransitionMode.MFASTModeAllowedByScript;
					transition.TriggerAllowedByVBScript = Util.RequireText(trigger.Script, "trigger.script");
					break;
				case "days":
					if (!trigger.Days.HasValue || trigger.Days.Value < 0)
						throw new ArgumentException("trigger.days must be 0 or more for mode \"days\".");
					transition.TriggerMode = MFAutoStateTransitionMode.MFASTModeRelativeTime;
					transition.TriggerInDays = trigger.Days.Value;
					break;
				case "assignment_complete":
					transition.TriggerMode = MFAutoStateTransitionMode.MFASTModeAssignmentComplete;
					break;
				case "assignment_complete_one":
					transition.TriggerMode = MFAutoStateTransitionMode.MFASTModeAssignmentCompleteOne;
					break;
				case "assignment_complete_all":
					transition.TriggerMode = MFAutoStateTransitionMode.MFASTModeAssignmentCompleteAll;
					break;
				case "assignment_rejected":
					transition.TriggerMode = MFAutoStateTransitionMode.MFASTModeAssignmentRejected;
					break;
				default:
					throw new ArgumentException(
						$"trigger.mode \"{trigger.Mode}\" isn't supported. Use none, script, days, assignment_complete, assignment_complete_one, assignment_complete_all or assignment_rejected.");
			}
		}

		private static int ResolveState(WorkflowAdmin workflow, int? id, string name, string field)
		{
			var states = Views.States(workflow);
			if (id.HasValue)
			{
				if (!states.Any(s => s.ID == id.Value))
					throw new ArgumentException($"{field}: state {id.Value} isn't in workflow {workflow.Workflow.ID}.");
				return id.Value;
			}
			var wanted = Util.RequireText(name, field + " (or its _name)");
			var matches = states.Where(s => SameName(s.Name, wanted)).ToList();
			if (matches.Count == 0)
				throw new ArgumentException($"{field}: workflow {workflow.Workflow.ID} has no state named \"{wanted}\".");
			if (matches.Count > 1)
				throw new ArgumentException($"{field}: several states are named \"{wanted}\" ({string.Join(", ", matches.Select(s => s.ID))}); pass the ID.");
			return matches[0].ID;
		}

		private static StateAdmin FindState(WorkflowAdmin workflow, int id)
		{
			var state = Views.States(workflow).FirstOrDefault(s => s.ID == id);
			if (state == null)
				throw new ArgumentException($"State {id} isn't in workflow {workflow.Workflow.ID}.");
			return state;
		}

		private static StateTransition FindTransition(WorkflowAdmin workflow, int id)
		{
			var transition = Views.Transitions(workflow).FirstOrDefault(t => t.ID == id);
			if (transition == null)
				throw new ArgumentException($"Transition {id} isn't in workflow {workflow.Workflow.ID}.");
			return transition;
		}

		private static void RequireUniqueNames(IEnumerable<string> names, IEnumerable<string> existing)
		{
			var seen = new HashSet<string>(existing.Where(n => n != null).Select(n => n.Trim()), StringComparer.OrdinalIgnoreCase);
			foreach (var name in names)
			{
				if (!seen.Add(name))
					throw new ArgumentException($"There's already a state named \"{name}\" in this workflow.");
			}
		}

		private static void SetAliases(WorkflowAdmin workflow, List<string> aliases)
		{
			var joined = Util.JoinAliases(aliases);
			if (joined.Length == 0)
				return;
			if (workflow.SemanticAliases == null)
				workflow.SemanticAliases = new SemanticAliases();
			workflow.SemanticAliases.Value = joined;
		}

		private static bool SameName(string a, string b)
		{
			return string.Equals((a ?? "").Trim(), (b ?? "").Trim(), StringComparison.OrdinalIgnoreCase);
		}
	}
}

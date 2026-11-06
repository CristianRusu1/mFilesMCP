# MFilesMCP vault app

A small [Vault Application Framework](https://developer.m-files.com/Frameworks/Vault-Application-Framework/) (VAF) app that lets the `mcp-mfiles` server read and change a vault's **metadata structure**.

The M-Files REST API can read some structure but not change it: `/structure/*` only supports GET, and it doesn't show scripts, event handlers or aliases at all. Changing structure needs the COM API in server mode (`AddPropertyDefAdmin`, `UpdateObjectClassAdmin`, `UpdateWorkflowAdmin`, `SetEventHandlers`, ...). This app wraps those calls in vault extension methods, which the MCP server reaches through `POST /REST/vault/extensionmethod/{name}`.

You only need it for these MCP tools:

| MCP tool | Extension method |
|---|---|
| `mfiles_structure_app_status` | `MFilesMCP_Ping`, `MFilesMCP_CheckAdminSession` |
| `mfiles_structure_job` | `MFilesMCP_GetJob` |
| `mfiles_get_admin_definition`, `mfiles_get_workflow`, `mfiles_list_event_handlers` | `MFilesMCP_Read` |
| `mfiles_create_property_def` | `MFilesMCP_CreatePropertyDef` (+ `MFilesMCP_UpdateClass` for `add_to_classes`) |
| `mfiles_update_property_def` | `MFilesMCP_UpdatePropertyDef` |
| `mfiles_create_object_type` | `MFilesMCP_CreateObjectType` (1.0.11+) |
| `mfiles_create_class` | `MFilesMCP_CreateClass` |
| `mfiles_update_class` | `MFilesMCP_UpdateClass` |
| `mfiles_create_value_list` | `MFilesMCP_CreateValueList` |
| `mfiles_create_workflow` | `MFilesMCP_CreateWorkflow` |
| `mfiles_update_workflow` | `MFilesMCP_UpdateWorkflow` |
| `mfiles_set_event_handler` | `MFilesMCP_SetEventHandler` |

Object-level writes (`mfiles_update_object_properties`, `mfiles_create_object`, `mfiles_create_value_list_item`) use the plain REST API and work without it.

## How a change runs

- **Jobs.** Apart from `MFilesMCP_Ping` and `MFilesMCP_GetJob`, every method checks its input, queues a job and returns it at once. On M-Files 25.11 a class save shows up within seconds but its call can stay open for up to 2 minutes. So the app waits 10 seconds for the call, then finishes the job as soon as the class's regular read shows the change, and notes on the job what the call did later. One worker thread runs the jobs in order (`Jobs.cs`), and the MCP server polls `MFilesMCP_GetJob`. Structure changes made while an extension method waited took 20 seconds to 2 minutes on one server, longer than MCP clients wait for a tool call. Jobs are kept in memory for two hours and are lost when the vault restarts.
- **The admin session.** Changes that read something before they write it go through an administrative session the app opens itself (`AdminSession.cs`): its own connection to the local M-Files server, then `LogInToVaultAdministrative`, the way M-Files Admin connects. That covers class, workflow, event handler and property updates. On the M-Files 25.11 server this was tested on, it logs in as the app's Windows account (NT AUTHORITY\SYSTEM) and reads workflows, event handlers and property definitions completely.
  - The app first logs in as the Windows account it runs under, normally LocalSystem, which M-Files treats as a server administrator. No password is involved.
  - If that fails, the job fails with `error_code: "admin_login_failed"`. The MCP server then resends the job with `MFILES_USERNAME`/`MFILES_PASSWORD` from its environment, and the app logs in with those. `MFILES_STRUCTURE_LOGIN=windows` on the MCP server stops it from sending them.
  - The session's account must have the `Change metadata structure` right, or it isn't used.
  - It connects to `ncacn_ip_tcp localhost:2266` unless the MCP server sends other endpoints (`MFILES_STRUCTURE_SERVER_ENDPOINT`).
  - `mfiles_structure_app_status` opens the session and says whether it worked, and as whom.
- **Creating** property definitions, classes and value lists uses the admin session when it opens, and `PermanentVault` otherwise. Creating a workflow always needs the admin session.

## Security model

- **Every method except Ping requires the `Change metadata structure` vault right** (`MFVaultAccessChangeMetaDataStructure`). The VAF checks it against the calling user before the method runs. `MFilesMCP_Ping` is open to any authenticated user. It returns the app's name, version and protocol number, the Windows account it runs as, the admin session's state, the job queue, and any startup error.
- **No change is saved from a copy that might be wrong.**
  - Classes: the MCP server sends the class as REST shows it (user properties, name, name property, workflow). The app reads the class through the admin session, then through `PermanentVault` and its variants, and only saves through a read that matches. It checks the new property list before saving, and re-reads the class afterwards. The MCP server checks again over REST and reports any property that should be there but isn't, with the call that restores it.
    - On M-Files 25.11, every admin copy of a class lists only its name property, whichever session reads it. The regular read, the one REST shows, has the full list.
    - When the admin copy only lacks properties, the app takes the list from the regular read. It first checks that the admin copy's object permissions, automatic permissions and aliases agree with the vault's, and refuses if they don't.
  - Workflows: the MCP server sends the workflow's name and state IDs from REST, and the app refuses if its copy differs. Afterwards it checks that no state or transition went missing and that scripts saved as sent.
  - Event handlers: M-Files only saves the whole list. The app re-reads it, refuses if the GUIDs differ from the ones the caller last read, and afterwards checks that every other handler is unchanged. The stub handlers M-Files generates for vault apps' extension methods, including this app's, are hidden from listings and can't be edited.
  - Property definitions: the MCP server sends the name, data type and value list from REST, and the app refuses if its copy differs.
- **Results include the previous version** of whatever changed (classes, workflow states and transitions, event handlers, property definitions), so a change can be undone from chat.
- **Nothing deletes structure.** No method removes property definitions, classes, value lists, workflow states or event handlers. The only removals are taking a property off a class and removing a workflow transition. Event handlers are switched off with `active: false`. The MCP server refuses to remove a class's name property.
- Inputs are validated twice: by the MCP server against the live structure (duplicate names, states and properties exist, object types match), and again by the app.
- The admin session stays open while the app runs. If it logged in with credentials, it counts as a session of that user.

## Build

It's a .NET Framework 4.7.2 class library built on the `MFiles.VAF` 24.10.720.2 NuGet package, so it needs M-Files Server 23.6 or newer. A build writes `bin/Release/MFilesMCP.VaultApp.mfappx`.

With the .NET SDK (Windows, macOS or Linux):

```bash
dotnet build -c Release
```

With Visual Studio, open `MFilesMCP.VaultApp.csproj` and build the Release configuration.

`VaultApplication` derives from `VaultApplicationBase` and also implements `IUsesVaultExtensionMethods`. Keep that interface: the VAF task manager registers an extension method of its own while the app starts, and throws without it. Versions up to 1.0.2 lacked it.

Don't turn on **Embed Interop Types** for `Interop.MFilesAPI`, even though older M-Files samples did. Embedding gives the COM types a different identity from the ones `MFiles.VAF.dll` uses, and M-Files' own interop package warns that this causes errors. Version 1.0.0 embedded them, and on an M-Files 25 server it stayed in "still starting up" indefinitely. Leaving embedding off also means `Interop.MFilesAPI.dll` ships inside the package.

To build against another VAF, change the `MFiles.VAF` version in the `.csproj` and set `required-mfiles-version` in `appdef.xml` to that VAF's minimum server version from the [VAF versions page](https://developer.m-files.com/Frameworks/Vault-Application-Framework/Versions/). VAF 24.10 needs M-Files 23.6 or newer.

## Install

1. Open **M-Files Admin**, then the vault, then **Applications**.
2. Click **Install...** and pick `MFilesMCP.VaultApp.mfappx`. Installing a newer version over an older one upgrades it in place.
3. Restart the vault when prompted.
4. From chat, call `mfiles_structure_app_status`. It should report `installed: true, compatible: true` and `admin_session.ok: true`.

If part of the VAF startup fails, the app keeps running and `mfiles_structure_app_status` shows the exception as `startup_error`. You don't need the server's event log for that. Before 1.0.2, a failed startup killed the app process, and M-Files answered every call with "vault applications are still starting up". `vault_ready: false` means the app has no vault connection, so structure changes will fail.

The MCP server also needs `MFILES_ALLOW_WRITES=true` in its environment, and its account needs the `Change metadata structure` right.

M-Files Cloud vaults only accept vault applications that M-Files has approved, so check with M-Files before planning on this there.

## Version history

- 1.0.11 (protocol 3): creates object types. Ping lists the app's methods, so tools that need a newer method can tell an older app apart without a protocol bump.
- 1.0.10 (protocol 3): stops waiting for a class save call once the change shows, since M-Files 25.11 can keep it open for 2 minutes after applying it. Also recognizes the event-handler stubs that call `GetExtensionObject`.
- 1.0.9 (protocol 3): checks aliases one by one where M-Files doesn't implement the vault-wide alias map (25.11), and shortens M-Files error messages in diagnostics.
- 1.0.8 (protocol 3): class updates take the property list from the regular read when the admin copy is incomplete, after checking that the class's permissions and aliases agree. Generated event handler stubs can't be edited.
- 1.0.7 (protocol 3): jobs, the admin session, class creation and class settings, workflows, event handlers, property scripts and validation. On M-Files 25.11 the admin session worked, but class updates were still refused because its admin copies of classes are just as incomplete.
- 1.0.5–1.0.6: refused class updates when every read of the class differed from REST, which on M-Files 25.11 was always.
- Up to 1.0.4: lost a class's existing properties when updating it. Don't use them for class updates.

## Test in a test vault first

Before installing a new version on a production vault, go through this checklist in a test vault:

- [ ] `mfiles_structure_app_status` → `installed: true`, `compatible: true`, `admin_session.ok: true`. With `verify_class_id`, the admin session's read of that class `matches`.
- [ ] `mfiles_update_class` on a test class: add a property, flip `required`, remove it. REST shows the class's other properties untouched.
- [ ] `mfiles_get_workflow` matches what M-Files Admin shows, scripts included.
- [ ] `mfiles_create_workflow` with two states and a transition; `mfiles_update_workflow` to add a state, a transition to it, and a state script.
- [ ] `mfiles_list_event_handlers` matches M-Files Admin → Event Handlers. `mfiles_set_event_handler` adds a test handler with `active: false`, and every other handler is unchanged.
- [ ] `mfiles_update_property_def` with a calculated value and a regex validation on a test property.
- [ ] With an account lacking `Change metadata structure`, the tools fail with a permissions hint.

## Protocol

Request and response bodies are JSON strings. Every method answers `{"ok":true,"result":...}` or `{"ok":false,"error":"..."}`. Job methods answer with the job: `{job_id, kind, status, step, result, error, error_code, diagnostics}`, where `status` is `queued`, `running`, `succeeded` or `failed`. `VaultApplication.Protocol` must equal `STRUCTURE_APP_PROTOCOL` in `src/structure-app.ts`, and the method names must equal `STRUCTURE_APP_METHODS`. Bump both protocol constants together whenever an existing method changes. `mfiles_structure_app_status` reports a mismatch. A new method doesn't need a bump: Ping's `methods` (1.0.11+) lists every method the installed build has, and a tool that needs a newer one says which version to install.

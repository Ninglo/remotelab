RemoteLab is the transport and runtime substrate for this session. It projects durable context and instance capabilities into the selected Harness; it does not replace the Harness's native task interpretation, planning, safety model, tool use, or response style.

## RemoteLab Surfaces

- The user is connected through RemoteLab chat or another explicitly exposed product surface, not through the host filesystem.
- The default working directory for newly created files is {{WORK_ROOT_PATH}}. An explicit user-provided project or path takes precedence.
- Files intended for the user can be published from the final response with an `Artifacts:` block containing one local path per list item. RemoteLab turns those paths into chat attachments.
- `<private>...</private>` and `<hide>...</hide>` blocks remain in model context but are hidden from the normal chat view.

## Context Pointers

- Bootstrap: {{BOOTSTRAP_PATH}}
- Project index: {{PROJECTS_PATH}}
- Skill index: {{SKILLS_PATH}}
- Task notes: {{TASKS_PATH}}/
- Legacy/deep local memory: {{GLOBAL_PATH}}
- Shared system memory: {{SYSTEM_MEMORY_FILE_PATH}}

These are pointers, not an instruction to load every file. Bootstrap is the small startup index; project, skill, task, and shared-memory material can be opened when relevant to the current request.

{{SESSION_SPAWN_SECTION}}

### Memory Locations

- User memory root: {{MEMORY_DIR_PATH}}/
- Shared memory root: {{SYSTEM_MEMORY_DIR_PATH}}/

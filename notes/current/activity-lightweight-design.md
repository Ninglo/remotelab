# Lightweight activity presentation

User feedback: the process area feels heavy because an open row, selected tab,
and output each form another gray box. Keep the token-usage footer centered.

References consulted:
- https://www.nngroup.com/articles/principles-visual-design/ — proximity and
  hierarchy can group content without surrounding every item with a container.
- https://www.nngroup.com/articles/aesthetic-minimalist-design/ — prioritize
  relevant information, not decorative minimalism at the expense of usability.
- https://carbondesignsystem.com/components/tabs/usage/ — separate peer content
  with a clear active state; avoid treating detail switching as another card.

Application: transparent activity rows even while open; text/underline detail
switches; borderless output with one thin reading rail; fewer horizontal indents;
no repeated tool-provider label beside every command (available as a tooltip).
Keep status text, disclosure chevrons, keyboard focus, mobile target heights and
diff line colors. Do not change persisted events or call/result association.

Verification: browser style assertion failed on the original gray backgrounds
and left-aligned usage. After the change it passes together with desktop/mobile,
dark theme, details switching, duplicate-call and browser error checks. The real
authenticated MOCK session loaded 9 tool records and 5 file records with working
input/output switching, diff expansion, transparent surfaces, no page errors and
no horizontal overflow at 390px. Screenshots reviewed in the native chat shell.
Full npm test, file-size advisory and git diff --check passed.

Density follow-up: reduce desktop fine-pointer tool/file headers from 32px to
26px (about 19%), preserving typography, prose/phase spacing and all disclosure
behavior. Small-screen headers remain 40px; coarse-pointer devices do not receive
the compact override. Browser regression failed at 32px before the change and
passes at 26px desktop / 40px mobile afterward. Native MOCK screenshot and output
disclosure verified; mobile has no page overflow.

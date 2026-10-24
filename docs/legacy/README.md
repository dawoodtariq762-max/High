# Legacy records (pre-rebrand)

These files are the audit trail of the codebase **before** it was rebranded to ALMADA SMS.
They are intentionally kept unchanged (only a one-line historical note was prepended), because
they explain how the current system was verified and what was removed on purpose.

| File | What it is |
|---|---|
| `Galaxy_SMS_README.md` | The full legacy handover README (route appendix, architecture, operations). Still the most detailed technical description of the runtime. |
| `AUDIT_REPORT.md` | The functionality/clean-source audit of the pre-rebrand package (section B lists the bugs fixed in the rebrand phase). |
| `FINAL-WORKSPACE.md` | Workspace finalization notes (what was kept/removed and why). |
| `UI-THEME-IMPLEMENTATION.md` | Notes for the light theme implementation. |
| `SAFE-UPDATE.md` | The legacy local-clone update procedure. |

Names of the previous brand appear throughout, deliberately: this folder is history, not
product surface. Nothing in here is shipped by the application.

## `release/` (repo root)

`release/*.json` and `release/obsolete-code-paths.txt` are dated records from the pre-rebrand
codebase (source manifests, change records, retired-file lists). They are kept for the audit
trail and are **not** executed by the application. Two consequences worth knowing:

* `release/source-manifest.json` lists the **pre-rebrand** file names (e.g. `assets/galaxy.css`).
  `tools/sync-local-clone.py` reads that file, so it needs a regenerated manifest before it can
  be used on the current tree.
* `release/obsolete-code-paths.txt` is a list of deliberately removed files — it is not a
  cleanup script (the audit report says the same).

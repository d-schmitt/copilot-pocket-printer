# Copilot Pocket Printer

Print your own compact bitmap cards from an AI client on a **Tronic 5890
Bluetooth thermal printer**, without the vendor app. Use GitHub Copilot to
preview a card, approve one print, and inspect the paper. A daily card is one
example, not the only purpose.

This demo is for technically comfortable Copilot users and presenters on
macOS. Your code can stay in Azure DevOps or GitLab: open a local folder in
Copilot, or use the client-neutral CLI/MCP core. No hosting migration is
required; this does not promise native pull-request feature parity across hosts.

![Synthetic 384-dot test pattern with border, text and stroke samples](examples/test-pattern.png)

*Safe first-print example: checked-in synthetic artwork, not a calendar or
personal card. The 384 x 288 pattern plus clearance uses about 46 mm of paper.*

## What works today

Merged `main` includes the PNG CLI, stable per-user installer, native helper,
and five portable MCP tools for preview, submission, receipts, cancellation,
and helper status. Real Copilot/helper test-pattern prints have been
user-confirmed in both confirmation modes, including one app approval with
no per-print helper click after explicit native opt-in.

**Not yet on main:** the compact daily-card renderer is under review in
[#13](https://github.com/d-schmitt/copilot-pocket-printer/pull/13).
Rendering through MCP, calendar acquisition, canvas controls, and scheduled
delivery remain [roadmap work](#what-this-showcases), not steps needed below.

## Try the demo

You need **macOS 13+, a working Swift toolchain, Python 3, and Node 22+**, a
reviewed checkout of current `main`, and the supported printer with paper,
powered on and nearby. Check the [revision-specific toolchain guidance](docs/development.md#toolchain-compatibility);
declared package minima are not a tested compatibility matrix.
The first build downloads the pinned Swift dependency. This is a source-built,
ad-hoc-signed demo, not a notarized consumer installer or a promise of support
for other printers, Windows, or Linux.

### 1. Prepare and install

From the checkout root, stage the standalone package:

```sh
python3 scripts/install_printer.py
```

This builds and verifies files under `.build/installation`; it does not install,
launch, register MCP, or access Bluetooth. After explicitly approving installation,
quit any previous helper and disconnect clients using the installation being
updated. Then copy the verified package without rebuilding:

```sh
python3 scripts/install_printer.py --install \
  --from-stage "$PWD/.build/installation/Copilot Pocket Printer"
```

The app and bridge now live together under
`~/Applications/Copilot Pocket Printer/`, independent of the checkout.
Keep Node installed separately. See [installation and updates](bridge/README.md#setup-with-explicit-approval-gates)
for refusal conditions and recovery; do not run these commands with `sudo`.

### 2. Open and authorize the helper yourself

After approving activation, independently open the installed **Pocket Printer
Helper.app in Finder**, not through Copilot, MCP, or a shell launcher. Press
**Enable Bluetooth** and approve the native request only if it names **Pocket
Printer Helper**. Stop on a different owner, denied access, or a launch block;
do not bypass macOS protections. Moving or rebuilding may request permission again.
**Keep the helper window open.**

For one app confirmation per print, explicitly enable **Use AI-client
confirmations (skip per-print helper click)** in that window. Otherwise native
confirmation remains the default, adding **Approve this one print** in the helper.

The opt-in trusts **any same-user program** asserting `paper_approved: true`;
it cannot attest a human click. A client set to **Always allow** may suppress
its prompt. Keep explicit per-job approval enabled and understand the
[trust boundary](bridge/README.md#confirmation-modes-and-trust).

### 3. Connect Copilot and preview

Approve registration of the `pocket-printer` stdio MCP server in Copilot.
Copy the installer's exact **Command** and **Arguments** values into the
corresponding settings fields. Arguments must be the entire JSON array,
including brackets and quotes, because the stable path contains spaces.
Do not register a worktree path or a command that launches the helper.

Obtain your printer UUID through the separately approved
[one-time native discovery](bridge/README.md#find-your-printer-once).
The helper window and `printer_helper_status` do not scan for devices.
Then ask Copilot:

> Check printer_helper_status and inspect examples/test-pattern.png through
> inspect_png using its base64 bytes. Show the returned preview and nominal
> paper use. Do not submit or print anything yet.

The [tool walkthrough](bridge/README.md#preview-and-approve-one-print) explains
the arguments. Preview needs an open helper but does not use Bluetooth.

### 4. Approve one print

Review the returned bitmap, target device, and approximately 46 mm paper use.
Give fresh approval for exactly one print. Copilot can then call `submit_png`
with that PNG, your device UUID, one new stable job UUID, and
`paper_approved: true`. In `ai_client` mode this may start immediately.

Follow the original ID with `get_print_job`. **Never automatically replay,
retry submission, or replace an uncertain job ID.** Cancellation cannot undo
sent bytes. `submitted_only` is local transport submission, not proof of
paper output; inspect the paper yourself.

## What this showcases

| Capability | Role in the demo | Status |
|---|---|---|
| Project | Coordination and shared context | Used to develop this demo |
| Sessions | Isolated implementation work | Used to develop this demo |
| MCP | Client-neutral PNG preview and approved printing | Available; [card rendering planned](https://github.com/d-schmitt/copilot-pocket-printer/issues/7) |
| WorkIQ | Optional calendar context | [Acquisition planned](https://github.com/d-schmitt/copilot-pocket-printer/issues/9) |
| Canvas | Interactive preview and section controls | [Planned](https://github.com/d-schmitt/copilot-pocket-printer/issues/8) |
| Automation | Scheduled card delivery | [Planned](https://github.com/d-schmitt/copilot-pocket-printer/issues/9); needs an awake Mac and available printer |

These are distinct capabilities, not a claim that all were new or generally
available at Universe.

## Privacy and other clients

Calendar integration is optional. Its required boundary is **validated meeting
times only**, never titles, attendees, customer/company names, or raw transcripts.
Main has no calendar acquisition or redaction service: arbitrary PNGs can
contain sensitive content, and your AI client may retain tool inputs and
previews. Use synthetic data for public demos.

Other compatible clients can use the same [stdio MCP bridge](bridge/README.md)
or [native CLI](docs/cli.md); neither requires Copilot or WorkIQ. For deeper
work, see [contributor checks](docs/development.md) and
[architecture, privacy, and protocol notes](docs/architecture.md).

Built on MIT-licensed
[PocketPrinter5890](https://github.com/dimer47/PocketPrinter5890).
Keep [NOTICE](NOTICE) with linked binaries; the reviewed repair revision is
pinned in [Package.swift](Package.swift) and [Package.resolved](Package.resolved).

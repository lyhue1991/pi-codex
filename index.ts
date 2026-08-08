/**
 * pi-codex — Bring Codex-like AI coding experience to Pi.
 *
 * Entry point that registers all extensions in this package:
 *   - bash extension (bash / bash_io tools)
 *   - goal extension (/goal command + goal tools + auto-continuation)
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import bashExtension from "./src/bash.ts";
import goalExtension from "./src/goal.ts";

export default function (pi: ExtensionAPI) {
	bashExtension(pi);
	goalExtension(pi);
}

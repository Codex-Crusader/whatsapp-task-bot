# Code signing policy

Free code signing provided by [SignPath.io](https://about.signpath.io), certificate by [SignPath Foundation](https://signpath.org).

## What is signed

The Windows installer (`WhatsApp-Task-Bot-Setup-<version>.exe`) of each release on the [releases page](https://github.com/Codex-Crusader/whatsapp-task-bot/releases).

The GitHub release workflow (`.github/workflows/release.yml`) builds the installer from the source code in this repository. No person builds a release on their own computer. The installer contains these upstream files without a new signature: the Node.js runtime (`node.exe`, signed by its publisher) and the npm packages in `node_modules`.

## Team roles

| Role | Members |
|---|---|
| Committers and reviewers | [Codex-Crusader](https://github.com/Codex-Crusader) |
| Approvers | [Codex-Crusader](https://github.com/Codex-Crusader) |

Committers can change the source code directly. Reviewers check every change from other people, such as pull requests, before it is merged. Approvers approve each signing request. All members use multi-factor authentication for GitHub and for SignPath.

## Privacy policy

This program will not transfer any information to other networked systems unless specifically requested by the user or the person installing or operating it.

The program makes a network connection only for a feature that the user sets up or starts:

| Connection | When |
|---|---|
| WhatsApp | After the user links the program to their WhatsApp account. The program only reads messages. |
| Google Calendar | After the user uploads a Google key and enters a Calendar ID. Tasks go to the user's own calendar. |
| Gmail | After the user enters a Gmail address and an App Password. The daily report goes to the user's own address. |
| GitHub | When the user clicks "Check for updates" on the About page. |
| Ollama, winget | When the user clicks "Install Ollama" or "Download the model" in the setup. |

The language model operates on the user's computer. Message text does not go to a cloud service. [SECURITY.md](SECURITY.md) lists all data flows, how long the program keeps data, and how to delete it.

# Changelog

Each release has a Windows installer on the [releases page](https://github.com/Codex-Crusader/whatsapp-task-bot/releases). An update keeps your data.

## 1.2.0 (2026-10-14)

Changes you can see:

1. The dashboard opens on your tasks. Status moves to the "System" group of the sidebar. The state dot at the bottom of the sidebar opens the Status page.
2. Count buttons above the tasks show your overdue tasks, the tasks due today, the tasks of the next 7 days, and the tasks that need a review. Click one to see those tasks.
3. The Tasks page shows a short notice when WhatsApp, the language model, the calendar, or the email needs you, and a bar when new tasks arrive while the page is open.
4. After "Done", "Reopen", or "Delete", an "Undo" button reverses the change.
5. Press `/` to go to the search box. Press Escape to clear the selection.
6. A new person filter: "Mine and the group".
7. After Ollama was not available (for example, during an Ollama update), the bot reads the waiting messages as soon as Ollama answers again, not 5 minutes later.

Security and fixes:

1. A line break in a logged value can no longer make a fake line in the log.
2. The dashboard pages refuse access to the camera, the microphone, and the location.
3. The update check accepts only a GitHub address and a valid version number.
4. `config.example.json` had the old default for the original message. The default is now off, as in the program.
5. The setup page and the error pages linked to the old start page.

## 1.1.0 (2026-10-12)

1. Uncertain tasks (an unclear person, low confidence, or a date that the model guessed) get a "Needs review" warning with the reason. They still go to the calendar, with "?" in the title. "Confirm" or "Edit" removes the warning.
2. Each task gets a tag: assignment, exam, class, meeting, event, payment, form, errand, personal, or other.
3. The Tasks page has a search box, filters for the tag and the chat, sort options, and colored deadlines: red when overdue, orange within 24 hours, yellow within 3 days.
4. The original message text no longer goes to Google Calendar by default. When you change this setting, the bot rewrites the events that already exist.
5. The bot checks all output of the language model: only known fields, correct types, and maximum lengths.
6. A copy started from the Start menu no longer causes "port in use" errors every 5 minutes after "Start with Windows".
7. SECURITY.md lists all data flows, how long the bot keeps data, and what to do if the computer is lost.

## 1.0.0 (2026-10-12)

The first release as a Windows app:

1. An installer that needs no administrator rights and brings its own Node.js.
2. A guided setup with one step on each screen. You can skip any step.
3. A loading screen while the bot starts.
4. An About page with the version, an update check, and links to report a problem.

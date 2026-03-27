# How Claude Supervisor Works

## What Is It?

Claude Supervisor is a system that lets you run AI coding agents on a server and manage them from anywhere -- your phone, a tablet, or another computer. Think of it like a security camera system, but instead of watching rooms, you are watching AI assistants as they work on your code. You can see what they are doing in real time, approve or reject their actions, and even step in to help when they get stuck.

Without a supervisor, you would need to sit in front of the terminal the entire time the AI is working, manually approving each sensitive action. The supervisor automates most of that, only paging you for the decisions that actually matter.

## The Web Dashboard: Your Control Room

The web interface is a single-page dashboard split into two main areas.

On the left is the **terminal panel**. Each tab represents a separate AI agent working on a different project. You see exactly what the agent sees -- the same terminal output, scrolling in real time. You can open new sessions, restart them, and even type into them directly if you need to nudge an agent in a different direction.

On the right is the **approval panel**. This is where pending decisions appear -- actions the AI wants to take but needs permission for. Each card shows what tool the agent wants to use and a summary of what it plans to do. You can approve, deny, or let the AI supervisor decide. Below the approvals, an activity log shows everything that has happened: files read, commands run, and approvals granted.

There is also an **agent activity section** that shows the status of subagents (helper workers spawned by the main agent), their progress percentages, and any discoveries they have reported. And a **coordinator section** that tracks cross-project help requests -- more on that below.

## How AI Agents Run: Terminals and dtach

Each AI agent runs inside a persistent terminal session on the server. The system uses a tool called "dtach" to keep these sessions alive even if you close your browser or the server restarts. This is similar to how you might leave a program running on a remote computer and come back to it later -- the agent keeps working whether you are watching or not.

When you connect to the dashboard, the system replays recent terminal output so you can catch up on what happened while you were away. Multiple people can watch the same terminal simultaneously, but only one person controls the keyboard at a time, preventing conflicting inputs.

## The Approval System: Guardrails for AI

This is the core safety mechanism. Every action an AI agent wants to take passes through a series of "hooks" -- checkpoints that fire before, during, and after each operation.

**Before a tool runs** (the pre-tool-use hook), the system makes a quick decision:

- **Auto-approve safe actions.** Reading files, searching code, and running basic commands like `git status` go through instantly with no delay. These cannot cause harm.
- **Auto-deny dangerous actions.** Commands that could wipe a disk or destroy data are blocked outright, no questions asked.
- **Everything in between goes to the supervisor.** This is where it gets interesting.

For actions that are not obviously safe or dangerous, the system sends the request to the supervisor server. In **auto mode** (the default), a second AI evaluates the request -- essentially asking "is this action safe and reasonable given what the agent is trying to do?" If the evaluating AI is confident, it approves or denies automatically. If it is uncertain, the request gets escalated to the human dashboard, where you see the yellow approval card and make the call yourself.

There are three modes total:

- **Auto**: The AI supervisor handles most decisions; you only see the tricky ones.
- **Assisted**: The AI recommends approve or deny, but you must confirm every decision.
- **Manual**: No AI involvement; you approve everything yourself.

After a tool finishes running, a **post-tool-use hook** logs what happened, creating the audit trail you see in the dashboard. This also publishes activity updates so other agents can see what their siblings are doing.

## Agent Communication: How Agents Talk to Each Other

When a complex task requires multiple AI agents working in parallel -- say, one researching a bug while another writes tests -- they need a way to share findings. The system uses MQTT for this, which is a lightweight messaging system commonly used in smart home devices and sensors.

Each agent can publish status updates ("started", "50% done", "completed"), share discoveries ("the auth tokens expire after 1 hour, not 24"), and coordinate on shared decisions. The supervisor server subscribes to all these messages and relays them to the dashboard, so you see a live feed of what every agent is doing and finding.

Agents use a small helper command called `sv` that wraps all this messaging into simple one-liners. They can also set up chat rooms for structured back-and-forth discussions -- useful when two agents need to debate an approach before committing to it.

## The Coordinator: Cross-Project Help Desk

Sometimes an agent working on one project needs information from a completely different project. The coordinator acts as a dispatcher for these requests.

An agent sends a help request like "check if getUserById returns null or throws on a missing user" targeted at a specific project. The coordinator finds the running session for that project and injects the question directly into the terminal. The receiving agent investigates, then publishes a response that the original requester can pick up. The whole exchange is tracked in the coordinator section of the dashboard, where you can see pending requests, dispatched queries, and completed responses.

## The Safety Net: Pre-Compaction Auto-Save

AI agents have a limited "context window" -- essentially their working memory. When a conversation gets too long, older content gets compressed to make room, and the agent loses detailed memory of earlier work. This is called compaction.

The pre-compaction hook fires just before this happens and automatically commits any uncommitted code changes to git. This way, even if the agent forgets what it was doing, the work is preserved. When the agent recovers, it can check the git history to see what was already done and pick up where it left off, guided by instructions that are re-loaded after every compaction.

## A Day in the Life: How a Typical Interaction Flows

You open the dashboard on your phone and tap "New Session" to start an agent on your web app project. The agent launches in a terminal tab. You type: "Fix the login bug where users get logged out after 5 minutes."

The agent reads several files to understand the codebase (auto-approved instantly). It spawns two subagents -- one to investigate the session configuration, another to check the token refresh logic. Their progress appears in the agent activity panel.

The investigating agent publishes a discovery: "Session timeout is hardcoded to 300 seconds in config.js." The main agent decides to edit that file. The edit goes through auto-approval since it is a normal project file.

Then it wants to run a deployment script. This is not on the auto-approve list, so the request lands on your dashboard. You see the card: "Bash: ./deploy.sh --staging". You tap Approve.

The fix goes out. The agent runs the test suite (auto-approved), confirms all tests pass, and commits the change. The whole interaction took a few minutes, and you only had to make one decision.

Meanwhile, the pre-compaction hook has been quietly saving progress at every memory boundary, and the post-tool-use hooks have been logging every action, giving you a complete record of everything that happened.

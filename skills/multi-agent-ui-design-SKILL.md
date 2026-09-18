---
name: multi-agent-ui-design
description: Design and implement visually striking, animated, production-grade interfaces for multi-agent systems. Use spatial agent representations, meaningful motion, visible data flow, expressive process states, and strong visual direction instead of generic SaaS dashboards.
---

# Multi-Agent UI Design

## Purpose

Use this skill when designing, redesigning, or implementing a frontend for a multi-agent system.

The goal is **not** to build a conventional SaaS dashboard.

The interface should feel like a **living computational environment**, command center, AI operations room, digital laboratory, or autonomous agent ecosystem where users can visually understand:

- which agents exist
- what each agent is responsible for
- which agents are active
- which agents are waiting
- what data is moving between agents
- what dependencies exist
- which processes are running
- what has completed
- what failed
- what is blocked
- how far a task has progressed
- how the overall system is coordinated

The UI should be visually memorable, interactive, cinematic where appropriate, and still production-ready.

---

# Core Design Principle

**Never represent a multi-agent system primarily as tables, cards, status badges, or ordinary dashboard widgets when a spatial, animated, or relational representation can communicate the same information more effectively.**

Treat:

- agents as actors
- communication as visible movement
- tasks as objects or activities
- dependencies as relationships
- processes as animation
- state changes as visual events
- the application as a living computational environment

Avoid defaulting to:

- generic sidebar layouts
- rows of metric cards
- static node diagrams
- plain admin dashboards
- tables full of agents
- excessive glassmorphism
- meaningless gradients
- decorative animation that does not communicate system state

---

# Visual Direction

Aim for a distinctive visual identity.

Possible references in spirit:

- futuristic AI operations center
- autonomous robotics lab
- cybernetic command room
- digital organism
- distributed intelligence network
- mission control
- holographic workstation
- living systems map

Do not copy any specific product.

The result should feel original.

Use:

- strong typography
- hierarchy
- depth
- layered surfaces
- subtle lighting
- controlled glow
- atmospheric backgrounds
- animated connections
- spatial grouping
- contextual HUD elements
- asymmetric composition where useful
- visual focus around active processes

Do not make every element glow.

Reserve visual intensity for:

- active agents
- important transitions
- errors
- incoming work
- data transfer
- high-priority operations

Idle parts of the interface should remain calmer.

---

# Agent Representation

Agents should feel like distinct entities, not identical boxes.

Each agent should have some combination of:

- name
- role
- avatar
- visual identity
- iconography
- accent treatment
- current state
- current task
- progress
- activity indicator
- relationship to other agents
- latest output
- capability indicators

Possible agent roles:

- Orchestrator
- Planner
- Researcher
- Coder
- Reviewer
- Analyst
- Memory Agent
- Database Agent
- Tool Agent
- Security Agent
- QA Agent
- Deployment Agent

Do not use identical visual treatment for all agents.

Different roles should be recognizable at a glance.

---

# Robot / Character Agents

Where appropriate, represent agents as small robots, animated characters, drones, or digital avatars.

Robots should not merely be decorative.

Their behavior should reflect state.

Examples:

## Idle
- subtle breathing motion
- head movement
- low-intensity ambient animation
- sitting at workstation
- looking around occasionally

## Receiving Work
- agent turns toward incoming data
- workstation lights up
- notification pulse
- incoming packet reaches agent
- agent acknowledges task

## Running
- typing
- scanning
- manipulating holographic controls
- moving between nearby work areas
- processing indicator activates
- energy ring or progress halo appears

## Waiting
- agent pauses
- looks toward dependency
- muted activity animation
- connection to dependency remains highlighted

## Blocked
- agent visibly stops
- warning icon appears
- blocked dependency is emphasized
- animation becomes subdued rather than chaotic

## Complete
- finishing motion
- output packet is generated
- output leaves the agent
- success state appears briefly
- agent settles back into calm idle state

## Failed
- agent stops
- warning state appears
- affected connection changes state
- retry action can become available
- avoid excessive red flashing

---

# Spatial Layout

Prefer spatial composition over rigid dashboard layout.

Agents can occupy a shared workspace.

Example:

```text
                      Researcher
                          │
                          ↓
          Memory ─── Orchestrator ─── Coder
                          │
                    ╱     │     ╲
                   ↓      ↓      ↓
               Database  Tools  Reviewer
```

This is only a conceptual example.

Do not automatically use a tree layout.

Choose layout based on actual system architecture.

Possible layouts:

- orchestration hub
- distributed network
- pipeline
- swarm
- clustered teams
- hierarchical command structure
- timeline + graph
- task rooms
- process lanes

Support zooming, panning, focusing, and contextual inspection where useful.

---

# Data Flow Visualization

Communication between agents must be visually understandable.

Do not rely only on static lines.

Represent data transfer using meaningful animation.

Possible techniques:

- glowing packets
- traveling particles
- animated dashes
- pulses
- flowing streams
- moving document/file icons
- token streams
- energy trails
- progress moving along an edge
- expanding wave from sender to receiver

Different kinds of information may use different visual forms.

Examples:

## Prompt / Instruction
A compact pulse or message packet travels toward an agent.

## File
A small file object moves along the connection.

## API Request
A request pulse travels outward toward an external service.

## API Response
A second packet travels back.

## Streaming Tokens
Small particles continuously flow into or out of an agent.

## Large Dataset
Represent as a denser stream or container.

## Agent Result
A visible output artifact travels toward the orchestrator or next agent.

---

# Branching and Aggregation

Make multi-agent orchestration visually obvious.

When one task creates multiple agent jobs:

1. source agent activates
2. multiple connections illuminate
3. task packets split
4. destination agents activate
5. each agent progresses independently

When outputs are aggregated:

1. result packets return
2. packets converge
3. aggregator/orchestrator enters processing state
4. merged result appears

This should make parallelism understandable without requiring users to read logs.

---

# Agent State System

Every agent should support a consistent state model.

Recommended states:

```ts
type AgentState =
  | "idle"
  | "queued"
  | "starting"
  | "running"
  | "waiting"
  | "blocked"
  | "retrying"
  | "failed"
  | "cancelled"
  | "completed";
```

Each state should have:

- visual treatment
- animation behavior
- connection behavior
- label/icon
- accessibility-friendly non-color indicator

---

# State Visualization

## Idle
Visual:
- subdued
- low contrast
- calm ambient motion

Motion:
- slow
- minimal

## Queued
Visual:
- subtle anticipation state
- queued task visible

Motion:
- breathing/pulsing indicator
- no frantic animation

## Starting
Visual:
- agent waking up
- workstation activating

Motion:
- short activation transition

## Running
Visual:
- stronger focus
- active connection
- progress displayed where possible

Motion:
- meaningful continuous work animation

## Waiting
Visual:
- muted active state
- dependency highlighted

Motion:
- slower waiting loop

## Blocked
Visual:
- clear warning
- blocking dependency emphasized

Motion:
- stopped or interrupted workflow

## Retrying
Visual:
- retry counter
- link/activity reactivation

Motion:
- restart sequence

## Failed
Visual:
- clear failure indicator
- affected path visible
- error details available

Motion:
- animation stops
- avoid distracting loops

## Cancelled
Visual:
- neutral stopped state

Motion:
- graceful shutdown

## Completed
Visual:
- concise success feedback
- final artifact visible

Motion:
- short completion transition
- then return to calm state

---

# Progress Visualization

Progress should be easy to read without dominating the interface.

Possible approaches:

- progress halo around avatar
- circular ring
- workstation meter
- thin progress arc
- illuminated path length
- task bar in contextual panel
- segmented pipeline
- percentage only when meaningful

Do not fake precision.

If exact progress is unavailable, show semantic progress such as:

- Preparing
- Gathering context
- Planning
- Executing
- Reviewing
- Finalizing

---

# Process Visualization

Running processes should feel alive.

Examples:

## Research Agent
- scans sources
- document cards move into workspace
- search pulses appear
- results accumulate

## Coding Agent
- terminal/workstation activates
- code lines animate subtly
- files enter and leave workspace
- build/test states appear

## Reviewer
- incoming artifact appears
- scan passes over it
- issue markers appear
- approval/rejection result is emitted

## Database Agent
- data containers enter
- queries animate toward datastore
- records return
- query activity appears

## Orchestrator
- receives request
- decomposes task
- assigns subtasks
- monitors agents
- waits for results
- combines outputs

Animations should explain the process rather than merely decorate it.

---

# Microinteractions

Use microinteractions heavily, but purposefully.

Examples:

## Hover Agent
- avatar reacts subtly
- current task appears
- connected edges become clearer
- neighboring unrelated content fades slightly

## Select Agent
- workspace focuses on agent
- contextual details open
- dependencies and outputs highlight

## Receive Task
- agent acknowledges
- workstation powers on
- incoming packet locks into position

## Send Result
- output object leaves agent
- travels toward destination
- sender settles into next state

## Error
- process stops visibly
- error source is highlighted
- recovery action appears

## Retry
- failed path resets
- retry animation begins
- state returns to active

---

# Motion Choreography

Animation must communicate hierarchy and causality.

Prefer:

- clear sequencing
- staggered activation
- spring-based transitions
- smooth object movement
- layout animation
- subtle camera movement
- progressive disclosure

Avoid:

- random floating
- constant bouncing
- excessive glow pulses
- excessive particle fields
- animation on every element
- overly long transitions
- motion that delays interaction

Typical motion timing:

```text
Microinteraction:      120–220ms
Panel transition:      180–320ms
Agent activation:      250–500ms
Data transfer:         based on spatial distance
Completion feedback:   300–800ms
Ambient animation:     slow and subtle
```

Do not treat these timings as rigid rules.

---

# Camera / Focus Behavior

If the interface uses a large spatial canvas, support focus transitions.

Examples:

- clicking an agent smoothly centers it
- selecting a task highlights participating agents
- following a workflow moves attention through the graph
- expanding an agent workspace zooms slightly
- returning to overview restores network context

Avoid aggressive camera motion.

Users must always feel oriented.

---

# Recommended Technology

Choose based on the existing project.

For React / Next.js, prefer:

## Core UI
- React
- Next.js
- TypeScript
- Tailwind CSS or existing styling system

## Agent Graph / Topology
Prefer:

```text
@xyflow/react
```

Use for:

- agent nodes
- tools
- APIs
- memory
- databases
- queues
- dependencies
- interactive graph edges

Create custom nodes rather than using default node styling.

## Motion
Prefer:

```text
motion
```

or:

```text
framer-motion
```

depending on project setup.

Use for:

- transitions
- layout animation
- presence animation
- state changes
- microinteractions

## Advanced Timeline Animation
Use when justified:

```text
gsap
```

Use for:

- complex choreography
- coordinated timelines
- advanced path animation

Do not add GSAP if standard React animation is enough.

## Animated Character Agents
Consider:

```text
Rive
```

Good for:

- lightweight animated robots
- state machines
- reusable agent avatars
- character interaction

## 3D
Use selectively:

```text
three
@react-three/fiber
@react-three/drei
```

Use only if 3D materially improves the experience.

Do not make the entire interface 3D by default.

Prefer a polished **2.5D approach** when possible.

## State Management
Possible options:

```text
zustand
```

or the project's existing state manager.

## Live Agent Events
Use:

- WebSockets
- Server-Sent Events
- existing realtime infrastructure

Map backend events directly to frontend state transitions.

---

# 2D / 2.5D / 3D Guidance

Default preference:

**2.5D**

Use:

- layered UI
- illustrated or Rive agents
- shadows
- perspective
- depth
- animated network edges
- particles used sparingly
- subtle parallax

Choose full 3D only when:

- camera movement is core to the experience
- agents genuinely occupy a 3D world
- spatial depth adds information
- performance budget allows it

Do not use 3D just because it looks impressive.

---

# Visual Hierarchy

At any moment users should quickly understand:

1. What is currently happening?
2. Which agent is responsible?
3. What is waiting?
4. Where is data moving?
5. Has anything failed?
6. What is the overall progress?

The most active part of the system should visually command attention.

Do not make every agent equally prominent.

---

# Detail Panels

Spatial visualization should be primary, but detailed information may appear in contextual panels.

Good secondary panels include:

- agent details
- logs
- task history
- current prompt
- tools used
- token usage
- latency
- cost
- generated artifacts
- error details
- retries
- dependencies
- execution timeline

Panels should supplement the visualization, not replace it.

---

# Timeline

Where useful, include an execution timeline.

Example:

```text
00:00  User request received
00:01  Orchestrator planning
00:02  Research Agent started
00:02  Coding Agent queued
00:06  Research completed
00:06  Research result sent to Coding Agent
00:07  Coding Agent started
00:14  Reviewer started
00:17  Workflow complete
```

Users should be able to correlate timeline events with agents on the canvas.

Hovering or selecting an event may highlight the corresponding agent and connection.

---

# External Systems

Represent important external systems visually.

Examples:

- GitHub
- database
- search engine
- API provider
- filesystem
- cloud platform
- vector store
- browser
- terminal
- queue
- model provider

External systems should look different from agents.

Avoid making APIs look like robots.

---

# Logs

Logs should exist but should not dominate the primary experience.

Prefer:

- collapsible logs
- contextual logs per agent
- execution timeline
- event inspection
- filtering

Avoid:

- giant terminal filling the entire screen
- forcing users to read raw logs to understand workflow

---

# Sound

Sound is optional.

If used:

- muted by default or clearly controllable
- subtle
- short
- informative

Possible sounds:

- agent activation
- task arrival
- data transfer
- completion
- warning

Do not turn the interface into an arcade game.

---

# Accessibility

Animations must respect:

```css
@media (prefers-reduced-motion: reduce)
```

Provide reduced-motion alternatives.

Never communicate state by color alone.

Use combinations of:

- icon
- label
- shape
- animation
- pattern
- color

Maintain sufficient contrast.

Interactive graph elements must remain keyboard accessible where practical.

Tooltips and labels must be readable.

---

# Performance Budget

Visual quality must not destroy application performance.

Target smooth interaction.

Prefer GPU-friendly animation:

- transform
- opacity

Avoid repeatedly animating expensive layout properties.

Be cautious with:

- box-shadow animation
- filter blur
- large backdrop filters
- huge particle counts
- many simultaneous SVG filters
- thousands of animated DOM elements

Pause or reduce animation when:

- tab is inactive
- agent is offscreen
- system is idle
- device performance is constrained

Use:

- lazy loading
- dynamic imports
- viewport detection
- animation throttling
- model compression
- texture compression
- memoization

For 3D:

- limit draw calls
- reuse geometry
- reuse materials
- avoid unnecessarily high polygon counts

---

# Responsiveness

Desktop can expose the full multi-agent world.

Tablet and mobile should preserve the concept without forcing the entire desktop graph onto a tiny screen.

For mobile consider:

- focused agent mode
- swipe between agents
- simplified topology overview
- bottom sheet details
- compact timeline
- pinch/zoom graph only where necessary
- reduced particle effects
- simpler robot animations

Do not simply shrink the desktop UI.

---

# Dark Mode

A darker interface often suits this visual language, but do not use plain black everywhere.

Use layered surfaces.

Examples:

- deep charcoal
- navy-black
- desaturated indigo
- subtle warm dark tones
- atmospheric gradients

Preserve readable contrast.

Light mode may exist where appropriate but does not have to mimic dark mode exactly.

---

# Empty State

Do not use a generic empty card.

An empty multi-agent system can show:

- sleeping agents
- inactive workstations
- dim connection network
- prompt encouraging user to start a workflow

The interface should communicate that the system is ready.

---

# Initial Request Animation

When a user submits a request:

1. request visibly enters system
2. orchestrator activates
3. planning begins
4. task graph is created
5. target agents activate
6. work starts
7. results flow through network
8. final result reaches destination

This sequence should make orchestration understandable.

---

# Example Interaction Story

A strong implementation could behave like this:

1. The system opens on an atmospheric network workspace.
2. The Orchestrator is positioned centrally.
3. Specialist agents sit around it.
4. All agents are calm and mostly idle.
5. User submits a request.
6. A request object travels toward the Orchestrator.
7. The Orchestrator activates.
8. A planning ring appears.
9. The workflow graph expands.
10. Three task packets split toward Researcher, Coder, and Database agents.
11. Researcher begins scanning.
12. Database agent performs queries.
13. Coder waits on research.
14. Researcher finishes.
15. Its result visibly travels to Coder.
16. Coder activates immediately.
17. Coder produces an artifact.
18. Artifact travels to Reviewer.
19. Reviewer checks it.
20. Reviewer approves.
21. Final packet returns to Orchestrator.
22. Workflow completes.
23. Network settles into a calm completed state.

The user should be able to understand this sequence without reading logs.

---

# Design Anti-Patterns

Avoid:

## Generic SaaS Dashboard

```text
Sidebar
Header
Metric Card
Metric Card
Metric Card
Agent Table
```

unless the product truly requires it.

## Identical Agent Cards

Do not show:

```text
Agent A    Running
Agent B    Running
Agent C    Complete
```

as the primary experience.

## Decorative Motion

Avoid meaningless:

- floating blobs
- endless bouncing icons
- random particle backgrounds
- glowing lines unrelated to data

## Excessive Cyberpunk

Do not automatically turn everything neon purple and cyan.

A sophisticated futuristic interface can be:

- restrained
- elegant
- cinematic
- minimal
- warm
- industrial
- scientific

## Animation Overload

Not everything should move simultaneously.

Motion needs hierarchy.

---

# Implementation Workflow

When applying this skill to an existing project:

## 1. Inspect Only What Is Necessary

Identify:

- framework
- routing
- component system
- styling approach
- agent data model
- realtime event source
- process states
- existing graph visualization
- existing dependencies

Do not waste tokens exploring unrelated code.

## 2. Understand the Agent Model

Determine:

- agent types
- agent relationships
- workflow model
- states
- task lifecycle
- communication model
- realtime events

## 3. Define Visual Semantics

Before implementing, establish how:

- agents look
- states look
- data moves
- dependencies appear
- failures appear
- progress appears

Keep these rules consistent.

## 4. Build the Core Spatial Experience

Prioritize:

1. agent visualization
2. connections
3. state transitions
4. data flow
5. contextual details

Do not start with secondary settings pages.

## 5. Add Motion

Add animation only after the state model is reliable.

## 6. Test Real Workflows

Verify:

- idle
- queueing
- parallel tasks
- sequential dependencies
- waiting
- retry
- failure
- success
- cancellation

## 7. Optimize

Profile:

- FPS
- CPU
- memory
- layout thrashing
- bundle impact
- WebGL usage if applicable

---

# Code Quality

Maintain production-grade code.

Prefer:

- reusable agent components
- reusable connection components
- centralized state mapping
- typed event models
- animation variants
- semantic design tokens
- clear separation between state and presentation

Example:

```ts
const agentVisualState = {
  idle: {},
  queued: {},
  starting: {},
  running: {},
  waiting: {},
  blocked: {},
  retrying: {},
  failed: {},
  cancelled: {},
  completed: {},
};
```

Avoid scattering random styling conditions throughout components.

---

# Event-Driven UI

The UI should respond to actual system events whenever possible.

Example events:

```ts
type AgentEvent =
  | { type: "agent.created"; agentId: string }
  | { type: "agent.started"; agentId: string }
  | { type: "agent.progress"; agentId: string; progress: number }
  | { type: "agent.waiting"; agentId: string; dependencyId?: string }
  | { type: "agent.completed"; agentId: string }
  | { type: "agent.failed"; agentId: string; error: string }
  | { type: "task.sent"; from: string; to: string; taskId: string }
  | { type: "data.sent"; from: string; to: string; dataType: string };
```

Use events to drive animation.

Do not create fake random activity merely to make the UI look alive.

---

# Final Quality Standard

Before considering the UI complete, ask:

- Does this feel specifically designed for a multi-agent system?
- Can I tell which agent is doing what without reading logs?
- Can I visually follow data moving through the system?
- Can I distinguish running, waiting, blocked, failed, and completed states?
- Do agents feel like actors rather than database rows?
- Does motion explain system behavior?
- Is the visual identity distinctive?
- Does it avoid looking like a generic AI-generated dashboard?
- Is animation performant?
- Is reduced motion supported?
- Does mobile receive a deliberately adapted experience?
- Can someone understand the system by watching it operate?

If several answers are "no", continue improving the design.

---

# Preferred Outcome

The final experience should feel less like:

> "Here is a dashboard showing several AI agents."

and more like:

> "I am watching an autonomous digital organization think, communicate, coordinate, and execute work in real time."

That is the target.

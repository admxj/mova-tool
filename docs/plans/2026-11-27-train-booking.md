# Train Booking Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Debug rail booking from station selection to seat reservation and order status, without payment.

**Architecture:** Separate the stateful booking flow from DOM rendering; inject the existing TMC API into the flow so offline tests can exercise real transitions. Register a native renderer tab and retain the global request inspector.

**Tech Stack:** Electron, vanilla JavaScript, Node built-in test runner.

---

### Task 1: Booking flow and API contract

- Create `test/train-booking.test.js` and `renderer/train-booking.js`.
- Run `node --test test/train-booking.test.js` before implementation; confirm missing module/behavior. Use mocked API responses to verify station/search selection, quote token, H5 application and policy gates, 12306 readiness, stale-context rejection, retry idempotency and order lookup.
- Implement the flow using [design](2026-11-27-train-booking-design.md) and source DTOs. Keep Go checks separate from Java booking. Do not invoke actual booking services during tests.
- Rerun `node --test test/train-booking.test.js`; commit the flow and tests.

### Task 2: Renderer and smoke coverage

- Modify `renderer/index.html`, add `renderer/train.js`, update `README.md`. Add a smoke assertion to the existing Electron smoke path to verify the train tab initializes.
- Confirm the smoke check first fails without the new tab, then connect the workflow to the existing API and inspector. Provide step-by-step inputs, opt-in confirmation before seat reservation, and manual status refresh.
- Run `npm run smoke`, `node --test test/train-booking.test.js`, and `git diff --check`; verify no real requests are issued. Commit the renderer and docs.

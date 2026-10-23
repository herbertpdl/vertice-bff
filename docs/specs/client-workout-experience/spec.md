# Spec: Client workout experience (BFF surface)

Status: Implemented
Owner: hebertpdl@gmail.com
Related: vertice-mobile `docs/prds/client-workout-experience/prd.md` and
`docs/specs/client-workout-experience/spec.md` §2.3 (B1–B10); vertice-api
`docs/specs/workout-session-lifecycle/spec.md` and `docs/specs/trainer-contacts-youtube-videos/spec.md`

## 0. Scope decisions

- **Sessions (B1–B6).** All new client routes call the vertice-api RPCs added for this feature.
  - `POST /api/workouts/{workoutId}/session/restart` (CLIENT) → `RestartWorkoutLog`, answered in
    the same `WorkoutSession` shape as `GET …/session`.
  - `DELETE /api/workout-sessions/{logId}` → `DiscardWorkoutLog`.
  - `DELETE /api/workout-sessions/{logId}/sets/{exerciseSetId}` → `DeleteSetLog`.
  - Both deletes answer 204, and 409 once the session is completed (FAILED_PRECONDITION).
  - `RecordSetLogRequest.weight` accepts `""`.
  - `WorkoutLog` gains `status` and `completionKind`, with the proto prefixes stripped. A log
    from an API without statuses reads as `COMPLETED`/`IN_PROGRESS` from `completedAt`.
  - Every `WorkoutSession` set carries `current`, this session's record (`ListSetLogs`), so a
    session resumes on another device.
- **Feedback (B7).** `SubmitFeedbackRequest` takes a required `rating` (five levels) and an
  optional `text` (`""` when the client only rated). `WorkoutFeedback`/`EnrichedFeedback` carry
  `rating` (null on old feedback) and `replaced`.
- **Trainer contacts (B8, B9).**
  - `GET /api/auth/me/trainer` (CLIENT) → `GetClientTrainer`: the name, and `email`, `whatsapp`
    and `instagram` as `""` unless the trainer shows them. 404 with no active trainer.
  - `Me` carries `whatsapp`, `instagram` and the three `show*` switches.
  - `PATCH /api/auth/me` takes them. Formatting is normalised: the phone keeps its digits, an
    Instagram handle drops a leading "@". `null` removes a contact.
  - An omitted contact is never sent upstream (proto3 `optional`), so the stored value stays.
  - A non-trainer sending contacts gets a 400.
- **YouTube-only videos (B10).** `ExerciseRequest.videoUrl` must be a YouTube video
  (`src/lib/youtube.ts`, the same reading as the mobile app and vertice-api).

## 1. Tests

- `src/modules/workout-sessions/routes.test.ts`:
  - session status and `current`, and the fallback for an API without statuses;
  - restart (the client's own);
  - discard and untick, with the 409 on a completed session;
  - a blank weight;
  - the feedback rating;
  - the trainer card and its 404;
  - contacts in `PATCH /auth/me`.
- The route-authorization table has the new routes, and schema tests cover the new bounds.

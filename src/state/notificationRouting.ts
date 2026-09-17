// Notification ROUTING only — deciding where a tap should take the
// creator. Actual notification delivery (permissions, push tokens,
// scheduling, the system banner/stack itself) is Paul's side and isn't
// built here; this is the swap point his real delivery code should call
// into once it exists, passing the same NotificationEvent shape.

export type NotificationEvent =
  // One finished video, its own notification tapped directly.
  | { type: "single"; projectId: string }
  // Multiple notifications collapsed into one iOS stack, the stack itself
  // (not an individual entry) tapped.
  | { type: "stack" }
  // One notification tapped after being expanded out of a stack.
  | { type: "expanded"; projectId: string };

export type NotificationRoute =
  // Deep-link straight into a specific video's timeline — no Home detour.
  | { screen: "studio"; projectId: string }
  // Open to My Projects — unread dots on the list do the rest.
  | { screen: "projects" };

export function resolveNotificationRoute(event: NotificationEvent): NotificationRoute {
  switch (event.type) {
    case "single":
      return { screen: "studio", projectId: event.projectId };
    case "expanded":
      return { screen: "studio", projectId: event.projectId };
    case "stack":
      return { screen: "projects" };
  }
}

const gesturePill = document.getElementById("gesturePill");

const SWIPE_GESTURE_LOCK_DISTANCE_PX = 18;
const SWIPE_GESTURE_TRIGGER_DISTANCE_PX = 64;
const SWIPE_GESTURE_DIRECTION_RATIO = 1.1;

let swipeGestureState = null;
let swipeGestureActionInFlight = false;

function canUseSwipeGestures() {
  if (!gesturePill) return false;
  if (isDesktop || visitorMode) return false;
  if (sidebarOverlay?.classList.contains("open")) return false;
  if (addToolModal && !addToolModal.hidden) return false;
  return true;
}

function isSwipeGestureBlockedTarget(target) {
  if (!(target instanceof Element)) return false;
  return Boolean(
    target.closest(
      "button, a, input, textarea, select, label, summary, pre, code, [contenteditable='true']",
    ),
  );
}

function resetGesturePill() {
  if (!gesturePill) return;
  gesturePill.classList.remove("visible", "ready", "left", "right");
  gesturePill.style.removeProperty("--gesture-offset");
  gesturePill.style.removeProperty("--gesture-scale");
}

function getSwipeGestureDirection(deltaX) {
  if (!Number.isFinite(deltaX) || deltaX === 0) return null;
  return deltaX > 0 ? "right" : "left";
}

function getSwipeGestureDistance(deltaX, direction) {
  if (direction === "right") return deltaX;
  if (direction === "left") return -deltaX;
  return 0;
}

function getSwipeGestureAction(direction) {
  if (direction === "right") {
    return {
      pillSide: "left",
      label: "Sessions",
      run: () => Promise.resolve(openSessionsSidebar()),
    };
  }
  if (direction === "left") {
    return {
      pillSide: "right",
      label: "New Session",
      run: () => Promise.resolve(createNewSessionShortcut()),
    };
  }
  return null;
}

function showGesturePill(direction, progress, distance) {
  if (!gesturePill) return;
  const action = getSwipeGestureAction(direction);
  if (!action) {
    resetGesturePill();
    return;
  }
  const clampedProgress = Math.max(0, Math.min(progress, 1.25));
  const offset = Math.min(Math.max(distance * 0.22, 0), 18);
  const directionOffset = action.pillSide === "left" ? offset : -offset;
  const scale = Math.min(1, 0.96 + clampedProgress * 0.06);
  gesturePill.textContent = action.label;
  gesturePill.classList.toggle("left", action.pillSide === "left");
  gesturePill.classList.toggle("right", action.pillSide === "right");
  gesturePill.classList.toggle("visible", clampedProgress > 0.05);
  gesturePill.classList.toggle("ready", clampedProgress >= 1);
  gesturePill.style.setProperty("--gesture-offset", `${directionOffset}px`);
  gesturePill.style.setProperty("--gesture-scale", String(scale));
}

function cancelSwipeGesture() {
  swipeGestureState = null;
  resetGesturePill();
}

function shouldCancelSwipeGesture(deltaX, deltaY) {
  if (Math.abs(deltaY) < SWIPE_GESTURE_LOCK_DISTANCE_PX) return false;
  return Math.abs(deltaY) > Math.abs(deltaX) * SWIPE_GESTURE_DIRECTION_RATIO;
}

function shouldLockSwipeGesture(deltaX, deltaY) {
  if (Math.abs(deltaX) < SWIPE_GESTURE_LOCK_DISTANCE_PX) return false;
  return Math.abs(deltaX) >= Math.abs(deltaY) * SWIPE_GESTURE_DIRECTION_RATIO;
}

function handleSwipeGestureStart(event) {
  if (!canUseSwipeGestures()) return;
  if (swipeGestureActionInFlight || swipeGestureState) return;
  if (event.touches.length !== 1) return;
  if (isSwipeGestureBlockedTarget(event.target)) return;

  const touch = event.touches[0];
  swipeGestureState = {
    direction: null,
    startX: touch.clientX,
    startY: touch.clientY,
    locked: false,
    distance: 0,
  };
}

function handleSwipeGestureMove(event) {
  if (!swipeGestureState) return;
  if (event.touches.length !== 1) {
    cancelSwipeGesture();
    return;
  }

  const touch = event.touches[0];
  const deltaX = touch.clientX - swipeGestureState.startX;
  const deltaY = touch.clientY - swipeGestureState.startY;

  if (!swipeGestureState.locked) {
    if (shouldCancelSwipeGesture(deltaX, deltaY)) {
      cancelSwipeGesture();
      return;
    }
    if (!shouldLockSwipeGesture(deltaX, deltaY)) {
      return;
    }
    swipeGestureState.locked = true;
    swipeGestureState.direction = getSwipeGestureDirection(deltaX);
  }

  if (!swipeGestureState.direction) {
    resetGesturePill();
    return;
  }

  const swipeDistance = getSwipeGestureDistance(deltaX, swipeGestureState.direction);
  swipeGestureState.distance = swipeDistance;

  if (swipeDistance <= 0) {
    resetGesturePill();
    return;
  }

  event.preventDefault();
  showGesturePill(
    swipeGestureState.direction,
    swipeDistance / SWIPE_GESTURE_TRIGGER_DISTANCE_PX,
    swipeDistance,
  );
}

function handleSwipeGestureEnd(event) {
  if (!swipeGestureState) return;

  const finalTouch = event.changedTouches?.[0] || null;
  if (finalTouch) {
    const deltaX = finalTouch.clientX - swipeGestureState.startX;
    const deltaY = finalTouch.clientY - swipeGestureState.startY;
    if (!swipeGestureState.locked && shouldLockSwipeGesture(deltaX, deltaY)) {
      swipeGestureState.locked = true;
      swipeGestureState.direction = getSwipeGestureDirection(deltaX);
    }
    swipeGestureState.distance = getSwipeGestureDistance(deltaX, swipeGestureState.direction);
  }

  const shouldTrigger =
    swipeGestureState.locked &&
    Boolean(swipeGestureState.direction) &&
    swipeGestureState.distance >= SWIPE_GESTURE_TRIGGER_DISTANCE_PX;
  const direction = swipeGestureState.direction;
  cancelSwipeGesture();
  if (!shouldTrigger || swipeGestureActionInFlight) return;

  const action = getSwipeGestureAction(direction);
  if (!action) return;

  swipeGestureActionInFlight = true;
  action.run().finally(() => {
    swipeGestureActionInFlight = false;
  });
}

document.addEventListener("touchstart", handleSwipeGestureStart, {
  passive: true,
  capture: true,
});
document.addEventListener("touchmove", handleSwipeGestureMove, { passive: false });
document.addEventListener("touchend", handleSwipeGestureEnd, { passive: true });
document.addEventListener("touchcancel", cancelSwipeGesture, { passive: true });

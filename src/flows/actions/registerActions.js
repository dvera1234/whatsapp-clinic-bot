import { registerAction } from "./actionDispatcher.js";

import {
  handlePlanMenu,
  handlePos,
  handleAttendant,
} from "./menuActions.js";

export function registerDefaultActions() {
  registerAction("PLAN_MENU", handlePlanMenu);
  registerAction("POS", handlePos);
  registerAction("ATTENDANT", handleAttendant);
}

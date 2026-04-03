import { registerAction } from "./actionDispatcher.js";

import { actionOpenSubmenu } from "./handlers/actionOpenSubmenu.js";
import { actionGoMain } from "./handlers/actionGoMain.js";
import { actionShowMessage } from "./handlers/actionShowMessage.js";
import { actionPlanMenu } from "./handlers/actionPlanMenu.js";
import { actionSelectPlan } from "./handlers/actionSelectPlan.js";
import { actionSelectCurrentPlan } from "./handlers/actionSelectCurrentPlan.js";
import { actionGoState } from "./handlers/actionGoState.js";

export function registerDefaultActions() {
  registerAction("OPEN_SUBMENU", actionOpenSubmenu);
  registerAction("GO_MAIN", actionGoMain);
  registerAction("SHOW_MESSAGE", actionShowMessage);
  registerAction("PLAN_MENU", actionPlanMenu);
  registerAction("SELECT_PLAN", actionSelectPlan);
  registerAction("SELECT_CURRENT_PLAN", actionSelectCurrentPlan);
  registerAction("GO_STATE", actionGoState);
}

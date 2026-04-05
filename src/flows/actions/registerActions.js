import { registerAction } from "./actionDispatcher.js";
import {
  actionOpenSubmenu,
  actionGoMain,
  actionPlanMenu,
  actionGoState,
  actionShowMessage,
  actionSelectPlan,
  actionSelectCurrentPlan,
} from "./menuActions.js";

export function registerDefaultActions() {
  registerAction("OPEN_SUBMENU", actionOpenSubmenu);
  registerAction("GO_MAIN", actionGoMain);
  registerAction("PLAN_MENU", actionPlanMenu);
  registerAction("GO_STATE", actionGoState);
  registerAction("SHOW_MESSAGE", actionShowMessage);
  registerAction("SELECT_PLAN", actionSelectPlan);
  registerAction("SELECT_CURRENT_PLAN", actionSelectCurrentPlan);
}

import { registerAction } from "./actionDispatcher.js";
import {
  actionOpenSubmenu,
  actionGoMain,
  actionPlanMenu,
  actionGoState,
  actionShowMessage,
} from "./menuActions.js";

export function registerDefaultActions() {
  registerAction("OPEN_SUBMENU", actionOpenSubmenu);
  registerAction("GO_MAIN", actionGoMain);
  registerAction("PLAN_MENU", actionPlanMenu);
  registerAction("GO_STATE", actionGoState);
  registerAction("SHOW_MESSAGE", actionShowMessage);
}

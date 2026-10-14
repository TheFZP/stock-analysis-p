/**
 * 系统通知工具 — 权限确保 + 发送（自选通知、均线提醒、价格提醒共用）
 */
import {
  isPermissionGranted,
  requestPermission,
  sendNotification,
} from "@tauri-apps/plugin-notification";
import { getCurrentWindow, UserAttentionType } from "@tauri-apps/api/window";
import { recordAlertEvent } from "./history";

const appWindow = getCurrentWindow();

/** 确保通知权限已授予 */
async function ensureNotificationPermission() {
  let permitted = await isPermissionGranted();
  if (!permitted) {
    permitted = (await requestPermission()) === "granted";
  }
  return permitted;
}

/**
 * 发送一条 Windows 原生通知（自动确保权限 + 任务栏闪烁提醒）。
 * @param {string} title
 * @param {string} body
 * @param {{code:string,kind:string,price?:number,target?:number}} [meta] 提供后额外落一条提醒事件到本地历史库
 * @returns {Promise<boolean>} 是否成功发送（权限被拒返回 false，调用方应中止后续发送）
 */
export async function sendAlertNotification(title, body, meta) {
  const permitted = await ensureNotificationPermission();
  if (!permitted) return false;
  // 任务栏闪烁黄色（UserAttentionType.Critical），直到用户聚焦窗口
  await appWindow.requestUserAttention(UserAttentionType.Critical);
  await sendNotification({ title, body });
  if (meta) recordAlertEvent({ ...meta, title, body });
  return true;
}

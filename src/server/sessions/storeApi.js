// 单会话读取的门面（getSession / getMessages），出 API 前统一走 db.js 的 rowTo* 转换。
import { rowToMessage, rowToSession } from '../db.js';
import { getMessageRows, getSessionRow } from './store.js';

/** @returns {object|null} Session（API JSON） */
export function getSession(id) {
    const row = getSessionRow(id);
    return row ? rowToSession(row) : null;
}

/** 会话消息（按 seq 升序）；limit<=0 表示全部 */
export function getMessages(sessionId, { limit = 0, offset = 0 } = {}) {
    return getMessageRows(sessionId, { limit, offset }).map(rowToMessage);
}

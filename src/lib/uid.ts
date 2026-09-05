/**
 * 짧은 고유 ID. MailBento widget-storage 의 uid() 와 동일한 형식이라
 * 시스템 메모함(레거시 JSON)에 그대로 써도 호환된다.
 */
export function uid(): string {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}

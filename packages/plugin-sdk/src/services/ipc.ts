export function errorMessage(error: unknown): string {
  if (typeof error === 'object' && error !== null && 'message' in error) {
    if (typeof error.message === 'string') return error.message;
  }
  return '操作未完成，请重试并检查本地应用日志。';
}

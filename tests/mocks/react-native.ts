export const Platform = { OS: 'web', select: <T,>(values: Record<string, T>) => values.web ?? values.default };

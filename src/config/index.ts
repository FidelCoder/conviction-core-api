export type AppConfig = {
  environment: string;
  logLevel: string;
  port: number;
};

export const config: AppConfig = {
  environment: process.env.NODE_ENV ?? "development",
  logLevel: process.env.LOG_LEVEL ?? "info",
  port: Number(process.env.PORT ?? 3000),
};

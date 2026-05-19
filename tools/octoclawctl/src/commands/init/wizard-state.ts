export interface WizardState {
  openclawVersion: string | null;
  judgeModel: {
    type: "ollama-qwen3" | "ollama-custom" | "remote-groq" | "remote-gpt-5-4-mini" | "remote-custom" | "skip";
    modelId: string;
    baseUrl: string;
    apiKey: string;
  } | null;
  imChannels: Array<"slack" | "feishu" | "discord" | "telegram" | "wechat">;
  imTokens: Record<string, Record<string, string>>;
  doctorResults: Array<{ name: string; status: "pass" | "warn" | "fail"; message: string }>;
}

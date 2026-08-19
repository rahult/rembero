import type { Metadata } from "next";
import { ChatMemoryLab } from "./chat-memory-lab";

export const metadata: Metadata = {
  title: "Remembero Lab — Same small model, different tool",
  description:
    "Watch the same local model call either a typed SQL tool or Remembero over one shared browser-local SQLite database.",
};

export default function ChatMemoryPage() {
  return <ChatMemoryLab />;
}

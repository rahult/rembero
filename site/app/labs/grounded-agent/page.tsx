import type { Metadata } from "next";
import { GroundedAgentLab } from "./grounded-agent-lab";

export const metadata: Metadata = {
  title: "Grounded Agent Lab — Let the gate show its work",
  description:
    "Compare a prompt-only refund agent with a grounded Remembero agent whose action must pass a deterministic policy gate.",
};

export default function GroundedAgentLabPage() {
  return (
    <main>
      <GroundedAgentLab />
    </main>
  );
}

export function mapFinishReason(stopReason?: string): string {
  switch (stopReason) {
    case "end_turn":
      return "stop";
    case "max_tokens":
    case "max_turn_requests":
      return "length";
    case "refusal":
      return "content_filter";
    case "cancelled":
      return "stop";
    default:
      return "stop";
  }
}

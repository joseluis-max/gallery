// No email provider was specified in the project spec. Rather than guess one (Resend,
// SendGrid, Postmark, ...) and add an unrequested dependency/credential, this is a small
// provider interface with a console-log fallback. Swap `ConsoleEmailProvider` for a real
// provider implementing the same interface when one is chosen.
export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
}

export interface EmailProvider {
  send(message: EmailMessage): Promise<void>;
}

export class ConsoleEmailProvider implements EmailProvider {
  async send(message: EmailMessage): Promise<void> {
    console.log(`[email:stub] to=${message.to} subject="${message.subject}"\n${message.text}`);
  }
}

let provider: EmailProvider = new ConsoleEmailProvider();

export function setEmailProvider(next: EmailProvider): void {
  provider = next;
}

export async function sendEmail(message: EmailMessage): Promise<void> {
  await provider.send(message);
}

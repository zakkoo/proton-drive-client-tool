import { createInterface } from 'node:readline';

/** Read a line from the terminal, optionally without echo (passwords, codes). */
export function prompt(question: string, hidden = false): Promise<string> {
  return new Promise((resolve, reject) => {
    const input = process.stdin;
    const output = process.stderr;
    const rl = createInterface({ input, output, terminal: true });
    if (hidden) {
      // Suppress echo by overriding the writer used while the question is pending.
      const anyRl = rl as unknown as { _writeToOutput: (s: string) => void };
      const original = anyRl._writeToOutput.bind(rl);
      let asked = false;
      anyRl._writeToOutput = (s: string) => {
        if (!asked) {
          original(s);
          asked = true;
        }
      };
    }
    rl.question(question, (answer) => {
      rl.close();
      if (hidden) output.write('\n');
      resolve(answer.trim());
    });
    rl.once('error', reject);
  });
}

export function confirm(question: string): Promise<boolean> {
  return prompt(`${question} [y/N] `).then((a) => /^y(es)?$/i.test(a));
}

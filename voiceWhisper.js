import fs from "fs";
import path from "path";
import OpenAI from "openai";

const openai = new OpenAI({
    apiKey: "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",
});
const speechFile = path.resolve("./speech.mp3");

const mp3 = await openai.audio.speech.create({
  model: "tts-1",
  voice: "onyx",
  input: "Irmão, vê se você consegue também aquela parada, ao invés de transcrever embaixo, transcrever fazendo um forward, para você mesmo, para o teu número.",
});

const buffer = Buffer.from(await mp3.arrayBuffer());
await fs.promises.writeFile(speechFile, buffer);
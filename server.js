const express = require('express');
const multer = require('multer');
const pdfParse = require('pdf-parse');
const path = require('path');

const app = express();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 } // Max 10 MB PDF
});

app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Strikt systeminstruktion som tvingar fram strukturerad JSON
const SYSTEM_PROMPT = `Du är en expert inom svensk affärsjuridik och avtalsrätt. Din uppgift är att analysera det inskickade avtalet och bryta ner det i logiska, lättöverskådliga kategorier (t.ex. Parter & Syfte, Avtalsperiod & Uppsägning, Pris & Betalningsvillkor, Ansvarsbegränsning, Sekretess & Immateriella rättigheter, Tvistlösning, Övriga viktiga villkor).

Du MÅSTE svara med ENDAST ett giltigt JSON-objekt (ingen markdown som \`\`\`json, ingen inledande eller avslutande text).

JSON-strukturen ska exakt följa detta schema:
{
  "contractTitle": "Kort identifierad titel på avtalet (t.ex. 'Konsultavtal - IT-tjänster')",
  "overallRisk": "Låg" | "Medel" | "Hög",
  "executiveSummary": "En kort övergripande sammanfattning av avtalet och dess balans på 2-3 meningar.",
  "categories": [
    {
      "id": "unikt-slug-id",
      "title": "Kategorins namn",
      "icon": "users" | "calendar" | "credit-card" | "shield-alert" | "lock" | "scale" | "file-text" | "alert-triangle",
      "riskLevel": "Låg" | "Medel" | "Hög" | "Info",
      "summary": "En tydlig och lättbegriplig sammanfattning på vanlig svenska av vad som gäller i denna del.",
      "keyPoints": [
        "Viktig hållpunkt eller konsekvens 1",
        "Viktig hållpunkt eller konsekvens 2"
      ],
      "originalText": "Exakta citat och klausuler direkt ur originaltexten som styrker sammanfattningen. Behåll paragrafnumrering om sådan finns."
    }
  ]
}`;

// Hjälpfunktion för att rensa eventuell markdown runt JSON-svaret
function cleanAndParseJSON(rawText) {
  const cleaned = rawText
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/i, '')
    .replace(/\s*```$/, '')
    .trim();
  return JSON.parse(cleaned);
}

// 1. Endpoint för att extrahera text ur uppladdad PDF
app.post('/api/analyze', upload.single('file'), async (req, res) => {
  try {
    const { provider, apiKey, model } = req.body;
    let contractText = req.body.text || '';

    // Om en PDF-fil laddats upp, extrahera texten
    if (req.file) {
      if (req.file.mimetype !== 'application/pdf') {
        return res.status(400).json({ error: 'Endast PDF-filer stöds för filuppladdning.' });
      }
      const pdfData = await pdfParse(req.file.buffer);
      contractText = pdfData.text;
    }

    if (!contractText || contractText.trim().length < 50) {
      return res.status(400).json({
        error: 'Avtalstexten är för kort eller kunde inte läsas (kontrollera att PDF-filen inte är en inskannad bild).'
      });
    }

    if (!apiKey || !provider) {
      return res.status(400).json({
        error: 'API-nyckel eller AI-leverantör saknas. Klicka på "API-nyckel (BYOK)" uppe till höger.'
      });
    }

    // Begränsa extremt långa texter (~120 000 tecken)
    const truncatedText = contractText.slice(0, 120000);
    let rawJsonResponse = '';

    // --- OPENAI ---
    if (provider === 'openai') {
      const selectedModel = model || 'gpt-4o-mini';
      const response = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey.trim()}`
        },
        body: JSON.stringify({
          model: selectedModel,
          response_format: { type: 'json_object' },
          temperature: 0.2,
          messages: [
            { role: 'system', content: SYSTEM_PROMPT },
            { role: 'user', content: `Analysera följande avtal:\n\n${truncatedText}` }
          ]
        })
      });

      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.error?.message || 'Fel vid anrop till OpenAI.');
      }
      rawJsonResponse = data.choices[0].message.content;
    }

    // --- GOOGLE GEMINI ---
    else if (provider === 'gemini') {
      const selectedModel = model || 'gemini-2.5-flash';
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${selectedModel}:generateContent?key=${apiKey.trim()}`;
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
          contents: [{ parts: [{ text: `Analysera följande avtal:\n\n${truncatedText}` }] }],
          generationConfig: {
            responseMimeType: 'application/json',
            temperature: 0.2
          }
        })
      });

      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.error?.message || 'Fel vid anrop till Google Gemini.');
      }
      rawJsonResponse = data.candidates[0].content.parts[0].text;
    }

    // --- ANTHROPIC CLAUDE ---
    else if (provider === 'claude') {
      const selectedModel = model || 'claude-3-5-sonnet-latest';
      const response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey.trim(),
          'anthropic-version': '2023-06-01'
        },
        body: JSON.stringify({
          model: selectedModel,
          max_tokens: 4096,
          temperature: 0.2,
          system: SYSTEM_PROMPT,
          messages: [
            { role: 'user', content: `Analysera följande avtal och svara ENDAST med giltig JSON:\n\n${truncatedText}` }
          ]
        })
      });

      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.error?.message || 'Fel vid anrop till Anthropic Claude.');
      }
      rawJsonResponse = data.content[0].text;
    } else {
      return res.status(400).json({ error: 'Ogiltig AI-leverantör vald.' });
    }

    const parsedResult = cleanAndParseJSON(rawJsonResponse);
    return res.json(parsedResult);

  } catch (error) {
    console.error('Analysfel:', error.message);
    return res.status(500).json({
      error: error.message || 'Ett oväntat fel uppstod vid analysen av avtalet.'
    });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Servern körs på http://localhost:${PORT}`);
});

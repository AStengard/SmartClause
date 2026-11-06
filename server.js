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

// Strict system prompt enforcing valid JSON output in English
const SYSTEM_PROMPT = `You are a senior commercial legal counsel and contract analysis expert. Your task is to analyze the submitted contract and break it down into logical, easy-to-navigate categories (e.g., Parties & Scope, Term & Termination, Pricing & Payment Terms, Liability & Indemnification, Confidentiality & IP Rights, Dispute Resolution, Miscellaneous / Special Clauses).

You MUST respond ONLY with a valid JSON object (no markdown formatting like \`\`\`json, no introductory or concluding text).

The JSON structure must strictly follow this schema:
{
  "contractTitle": "Short identified title of the contract (e.g., 'Master Services Agreement - IT Consulting')",
  "overallRisk": "Low" | "Medium" | "High",
  "executiveSummary": "A concise 2-3 sentence executive summary of the contract and its overall risk balance.",
  "categories": [
    {
      "id": "unique-slug-id",
      "title": "Category Name",
      "icon": "users" | "calendar" | "credit-card" | "shield-alert" | "lock" | "scale" | "file-text" | "alert-triangle",
      "riskLevel": "Low" | "Medium" | "High" | "Info",
      "summary": "A clear, plain-English summary of what applies in this section and its practical implications.",
      "keyPoints": [
        "Key takeaway or obligation 1",
        "Key takeaway or obligation 2"
      ],
      "originalText": "Exact verbatim quotes and clauses directly from the contract text that support this summary. Preserve section numbering if present."
    }
  ]
}`;

function cleanAndParseJSON(rawText) {
  const cleaned = rawText
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/i, '')
    .replace(/\s*```$/, '')
    .trim();
  return JSON.parse(cleaned);
}

app.post('/api/analyze', upload.single('file'), async (req, res) => {
  try {
    const { provider, apiKey, model } = req.body;
    let contractText = req.body.text || '';

    if (req.file) {
      if (req.file.mimetype !== 'application/pdf') {
        return res.status(400).json({ error: 'Only PDF files are supported for file upload.' });
      }
      const pdfData = await pdfParse(req.file.buffer);
      contractText = pdfData.text;
    }

    if (!contractText || contractText.trim().length < 50) {
      return res.status(400).json({
        error: 'The contract text is too short or could not be extracted (please make sure the PDF is not a scanned image without OCR).'
      });
    }

    if (!apiKey || !provider) {
      return res.status(400).json({
        error: 'Missing API key or AI provider. Click "API Key (BYOK)" in the top right corner.'
      });
    }

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
            { role: 'user', content: `Analyze the following contract:\n\n${truncatedText}` }
          ]
        })
      });

      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.error?.message || 'Error calling OpenAI API.');
      }
      rawJsonResponse = data.choices[0].message.content;
    }

    // --- GOOGLE GEMINI ---
    else if (provider === 'gemini') {
      const selectedModel = model || 'gemini-3.8-flash';
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${selectedModel}:generateContent?key=${apiKey.trim()}`;
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
          contents: [{ parts: [{ text: `Analyze the following contract:\n\n${truncatedText}` }] }],
          generationConfig: {
            responseMimeType: 'application/json',
            temperature: 0.2
          }
        })
      });

      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.error?.message || 'Error calling Google Gemini API.');
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
            { role: 'user', content: `Analyze the following contract and respond ONLY with valid JSON:\n\n${truncatedText}` }
          ]
        })
      });

      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.error?.message || 'Error calling Anthropic Claude API.');
      }
      rawJsonResponse = data.content[0].text;
    } else {
      return res.status(400).json({ error: 'Invalid AI provider selected.' });
    }

    const parsedResult = cleanAndParseJSON(rawJsonResponse);
    return res.json(parsedResult);

  } catch (error) {
    console.error('Analysis error:', error.message);
    return res.status(500).json({
      error: error.message || 'An unexpected error occurred while analyzing the contract.'
    });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`SmartClause server running on http://localhost:${PORT}`);
});

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

// Function to dynamically build the system prompt with single-pass POV detection
function buildSystemPrompt(userPartyName) {
  const povInstruction = userPartyName && userPartyName.trim() !== ''
    ? `CRITICAL POV INSTRUCTION: The user's organization or name is "${userPartyName.trim()}".
First, scan the contract to dynamically identify which defined party or role they represent (e.g., "Client", "Customer", "Contractor", "Supplier", "Licensor", "Employer", etc.) and who the counterparty is.
Then, conduct the ENTIRE risk assessment, executive summary, category summaries, and key takeaways strictly from "${userPartyName.trim()}"'s perspective (protecting their interests, flagging clauses that expose THEM to liability, financial risk, or unfavorable obligations).`
    : `POV INSTRUCTION: The user did not specify their organization name. Identify the primary parties in the contract, and conduct a balanced, objective risk assessment highlighting which party bears the risk in each section.`;

  return `You are a senior commercial legal counsel and contract analysis expert. Your task is to analyze the submitted contract and break it down into logical, easy-to-navigate categories (e.g., Parties & Scope, Term & Termination, Pricing & Payment Terms, Liability & Indemnification, Confidentiality & IP Rights, Dispute Resolution, Miscellaneous / Special Clauses).

${povInstruction}

You MUST respond ONLY with a valid JSON object (no markdown formatting like \`\`\`json, no introductory or concluding text).

The JSON structure must strictly follow this schema:
{
  "contractTitle": "Short identified title of the contract (e.g., 'Master Services Agreement - IT Consulting')",
  "overallRisk": "Low" | "Medium" | "High",
  "detectedPerspective": {
    "userInput": "The organization name provided by the user, or 'Neutral / Unspecified'",
    "matchedEntity": "The full legal name of the matched party in the contract (or 'All Parties (Balanced View)' if unspecified/not found)",
    "definedRole": "The contract's defined term for the user's party (e.g., 'Client', 'Contractor', 'Buyer', or 'Neutral')",
    "counterparty": "The full legal name and defined role of the other party (e.g., 'NextGen Dev Studio LLC (Contractor)')",
    "matchConfidence": "Exact Match" | "Partial Match" | "Inferred Role" | "Neutral POV"
  },
  "executiveSummary": "A concise 2-3 sentence executive summary of the contract and its overall risk balance, written directly from the detected perspective.",
  "categories": [
    {
      "id": "unique-slug-id",
      "title": "Category Name",
      "icon": "users" | "calendar" | "credit-card" | "shield-alert" | "lock" | "scale" | "file-text" | "alert-triangle",
      "riskLevel": "Low" | "Medium" | "High" | "Info",
      "summary": "A clear, plain-English summary of what applies in this section and its practical implications for the user's party.",
      "keyPoints": [
        "Key takeaway, risk, or obligation 1 from the user's perspective",
        "Key takeaway, risk, or obligation 2 from the user's perspective"
      ],
      "originalText": "Exact verbatim quotes and clauses directly from the contract text that support this summary. Preserve section numbering if present."
    }
  ]
}`;
}

// Lightweight regex pre-scan to give the LLM extra context on where the user's party name appears
function findPartyMentions(contractText, userPartyName) {
  if (!userPartyName || userPartyName.trim().length < 2) return '';
  const escaped = userPartyName.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const regex = new RegExp(`.{0,120}${escaped}.{0,120}`, 'gi');
  const matches = contractText.match(regex);
  if (!matches || matches.length === 0) return '';
  return `\n\n[PRE-SCAN HINT: The user's input "${userPartyName.trim()}" was found in the text near: "${matches.slice(0, 3).join(' ... ')}"]`;
}

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
    const { provider, apiKey, model, userParty } = req.body;
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
    const systemPrompt = buildSystemPrompt(userParty);
    const preScanHint = findPartyMentions(truncatedText, userParty);
    const userMessageContent = `Analyze the following contract:${preScanHint}\n\n${truncatedText}`;

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
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userMessageContent }
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
      const cleanModelName = selectedModel.replace(/^models\//, '');
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${cleanModelName}:generateContent?key=${apiKey.trim()}`;
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: systemPrompt }] },
          contents: [{ parts: [{ text: userMessageContent }] }],
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
          system: systemPrompt,
          messages: [
            { role: 'user', content: `${userMessageContent}\n\nRespond ONLY with valid JSON.` }
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
    // Attach the full extracted contract text so the user can read the entire agreement on the frontend
    parsedResult.fullContractText = contractText;
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

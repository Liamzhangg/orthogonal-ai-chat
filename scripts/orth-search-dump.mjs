const apiKey = process.env.ORTHOGONAL_API_KEY;

if (!apiKey) {
  console.error("ORTHOGONAL_API_KEY missing");
  process.exit(1);
}

const prompts = [
  "find email by name and company",
  "enrich a company by domain",
  "look up a person by linkedin url",
];

for (const prompt of prompts) {
  console.log(`\n=== ${prompt} ===`);
  const response = await fetch("https://api.orth.sh/v1/search", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ prompt, limit: 3 }),
  });

  const text = await response.text();
  console.log(`HTTP ${response.status}`);
  console.log(text);
}

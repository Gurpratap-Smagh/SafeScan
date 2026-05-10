import type { Product, SafetyReport, User, UserAllergy, UserCondition, UserMedication } from '@prisma/client';

function formatAllergy(a: UserAllergy): string {
  const name = a.allergen ?? a.name ?? 'unknown';
  return [name, a.severity ? `severity: ${a.severity}` : null].filter(Boolean).join(' — ');
}

function formatCondition(c: UserCondition): string {
  return c.conditionName ?? c.name ?? 'unknown';
}

function formatMedication(m: UserMedication): string {
  const name = m.medicationName ?? m.name ?? 'unknown';
  return [name, m.dosage, m.frequency].filter(Boolean).join(' | ');
}

export function buildSafetyAnalysisUserPrompt(input: {
  user: User;
  allergies: UserAllergy[];
  conditions: UserCondition[];
  medications: UserMedication[];
  report: SafetyReport;
  product: Product | null;
}): string {
  const { user, allergies, conditions, medications, report, product } = input;

  const lines: string[] = [];

  // --- User profile ---
  lines.push('## USER PROFILE');
  lines.push(`Name: ${user.name}`);
  if (user.country) lines.push(`Country: ${user.country}`);
  if (user.age != null) lines.push(`Age: ${user.age}`);
  lines.push('');

  lines.push('### Allergies (cross-reference every ingredient against this list):');
  if (allergies.length) {
    allergies.forEach((a) => lines.push(`- ${formatAllergy(a)}`));
  } else {
    lines.push('- none recorded');
  }
  lines.push('');

  lines.push('### Medical Conditions:');
  if (conditions.length) {
    conditions.forEach((c) => lines.push(`- ${formatCondition(c)}`));
  } else {
    lines.push('- none recorded');
  }
  lines.push('');

  lines.push('### Current Medications (check for interactions):');
  if (medications.length) {
    medications.forEach((m) => lines.push(`- ${formatMedication(m)}`));
  } else {
    lines.push('- none recorded');
  }
  lines.push('');

  // --- Product identity ---
  lines.push('## PRODUCT DATA (from barcode lookups, OpenFoodFacts, UPC databases)');
  const prodName = product?.name ?? 'Unknown';
  const brand = product?.brand;
  const manufacturer = product?.manufacturer;
  lines.push(`Current name on file: ${prodName}`);
  if (brand) lines.push(`Brand: ${brand}`);
  if (manufacturer) lines.push(`Manufacturer: ${manufacturer}`);
  if (product?.type) lines.push(`Category: ${product.type}`);
  if (product?.barcodeNumber) lines.push(`Barcode: ${product.barcodeNumber}`);
  if (product?.description) lines.push(`Description: ${product.description}`);
  lines.push('');

  // --- Full ingredient list ---
  lines.push('### Ingredient List (FULL — analyze every item against user allergies/conditions/meds):');
  if (product?.ingredientList) {
    lines.push(product.ingredientList.slice(0, 3000));
  } else {
    lines.push('(not available)');
  }
  lines.push('');

  // --- Nutritional data ---
  lines.push('### Nutritional Data (from API Ninjas, Edamam, OpenFoodFacts):');
  const hasNutrition = report.calories != null || report.sugarLevel || report.sodiumLevel || product?.nutritionalInfo;
  if (hasNutrition) {
    if (report.calories != null) lines.push(`Calories: ${report.calories}`);
    if (report.sugarLevel) lines.push(`Sugar level: ${report.sugarLevel}`);
    if (report.sodiumLevel) lines.push(`Sodium level: ${report.sodiumLevel}`);
    if (report.saturatedFatLevel) lines.push(`Saturated fat level: ${report.saturatedFatLevel}`);
    if (report.proteinLevel) lines.push(`Protein level: ${report.proteinLevel}`);
    if (report.fiberLevel) lines.push(`Fiber level: ${report.fiberLevel}`);
    if (report.nutritionalSummary) lines.push(`Raw nutrition data: ${report.nutritionalSummary}`);
    if (product?.nutritionalInfo) {
      const nutJson = typeof product.nutritionalInfo === 'string'
        ? product.nutritionalInfo
        : JSON.stringify(product.nutritionalInfo);
      lines.push(`Nutriments JSON: ${nutJson.slice(0, 1500)}`);
    }
    if (report.nutritionalFlags) lines.push(`Edamam health labels: ${report.nutritionalFlags}`);
    if (report.dailyValueWarnings) lines.push(`Daily value warnings: ${report.dailyValueWarnings}`);
  } else {
    lines.push('(not available)');
  }
  lines.push('');

  // --- FDA recalls ---
  lines.push('### FDA Recalls and Enforcement Actions:');
  if (report.potentialHarms) {
    const harms = typeof report.potentialHarms === 'string'
      ? report.potentialHarms
      : JSON.stringify(report.potentialHarms);
    lines.push(harms.slice(0, 2000));
  } else {
    lines.push('(none returned by FDA search)');
  }
  lines.push('');

  // --- FDA adverse events ---
  lines.push('### FDA Adverse Event Reports (FAERS + CAERS):');
  if (report.fdaReactionSummary) {
    lines.push(report.fdaReactionSummary);
  } else {
    lines.push('(none returned)');
  }
  if (report.fdaReportCount != null) {
    lines.push(`Total adverse reports matched: ${report.fdaReportCount}`);
  }
  lines.push('');

  // --- Drug interaction data ---
  if (report.drugFlags) {
    lines.push('### Drug/Medication Interaction Data:');
    lines.push(report.drugFlags);
    lines.push('');
  }

  // --- Toxicity signals ---
  if (report.toxicityFlags) {
    lines.push('### Toxicity Flags (from ingredients + news):');
    lines.push(report.toxicityFlags);
    lines.push('');
  }

  // --- Known reactions ---
  if (report.knownReactions) {
    lines.push('### Known Reactions from Adverse Databases:');
    lines.push(report.knownReactions);
    lines.push('');
  }

  lines.push('---');
  lines.push('TASK: Using ALL of the above data, produce a comprehensive, personalized safety analysis for this specific user.');
  lines.push('- Derive all scores yourself from the raw data — do NOT copy prior scores.');
  lines.push('- Set productName to the most accurate human-readable name (brand + product name when available).');
  lines.push('- Apply the CRITICAL ALLERGEN RULE from the system prompt without exception.');
  lines.push('- Tailor every score and narrative field to this user\'s allergies, conditions, and medications.');
  lines.push('Respond only with the fenced JSON described in the system message.');

  return lines.join('\n');
}

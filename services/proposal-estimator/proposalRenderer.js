// ✅ Step 1: Your provided HTML template
const htmlTemplate = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Proposal Template</title>
  <style>
    body { font-family: Verdana, sans-serif; color: #333; line-height: 1; }
    h1, h2, h3 { color: #111; page-break-after: avoid; break-after: avoid; }
    .header { text-align: center; margin: 20px 0; font-size: 14px; }
    .table { width: 100%; border-collapse: collapse; margin-top: 10px; }
    .table th, .table td { border: 1px solid #ccc; padding: 8px; text-align: left; }
    .signature { margin-top: 40px; }
    .center { text-align: center; }
    .page-break {
      page-break-before: always !important;
      break-before: page !important;
      page-break-after: always !important;
      break-after: page !important;
    }
    @media print {
      @page { size: A4; margin: 40px; }
    }
  </style>
</head>
<body>
  <div class="content">
    <div class="section" style="margin-top:40px;">
      <h1>🏗 Project Proposal</h1>
      <p>{{companyName}}</p>
      <p>{{companyAddress}}</p>
      <p>License: {{companyLicense}}</p>
      <h3>Proposal For:</h3>
      <p>{{client.data.name}}</p>
      <p>{{client.data.phone}}</p>
      <p>{{client.data.email}}</p>
      <p><strong>Proposal Date:</strong> {{currentDate}}</p>
      <p><strong>Proposal Valid Until:</strong> {{validUntil}}</p>
      <p><strong>Project Name:</strong> {{project.data.name}}</p>
    </div>

    <div class="page-break"></div>

    <div class="section">
      <h2>1. Project Overview</h2>
      <p style="line-height: 1.5; white-space: pre-line;">{{overview}}</p>
    </div>

    <div class="section">
      <h2>2. Scope of Work</h2>
      <table class="table">
        <thead>
          <tr>
            <th>Category</th>
            <th>Item Description</th>
            <th>Total ($)</th>
          </tr>
        </thead>
        <tbody>
          {{scopeItems}}
        </tbody>
      </table>
      <p style="line-height: 1.5">{{plan}}</p>
    </div>

    <div class="section">
      <h2>3. Exclusions & Allowances</h2>
      <ul>
        <li>Architectural, engineering, or design fees.</li>
        <li>Permit fees and associated costs.</li>
        <li>Landscaping, irrigation, or exterior site work beyond the project area.</li>
        <li>Unforeseen conditions such as mold, asbestos, termite damage, etc.</li>
      </ul>
      <h3>Allowances</h3>
      <ul>
        <li><strong>Plumbing Fixtures:</strong> {{amountPlumbing}}</li>
        <li><strong>Lighting Fixtures:</strong> {{amountLighting}}</li>
        <li><strong>Tile/Flooring:</strong> {{amountFlooring}}</li>
      </ul>
    </div>

    <div class="section">
      <h2>4. Project Value & Payment Schedule</h2>
      <p>The total value for the scope of work outlined above is <strong>{{totalAmount}}</strong>.</p>
      <ul>
        <li>Initial Payment (30%): {{initialPayment}}</li>
        <li>Milestone 1 (60%): {{milestonePayment}}</li>
        <li>Final Payment (10%): {{finalPayment}}</li>
      </ul>
    </div>

    <div class="section">
      <h2>5. Agreement</h2>
      <p>By signing below, both parties agree to the outlined scope and terms.</p>
      <div class="signature">
        <p>For {{client.data.name}}: ____________________</p>
        <p>For {{companyName}}: ____________________</p>
        <p>Printed Name: {{ownerName}}</p>
        <p>Title: {{ownerTitle}}</p>
      </div>
    </div>
  </div>
</body>
</html>`;




function renderTemplate(template, data) {
  const getValue = (path, obj) =>
    path.trim().split(".").reduce((acc, key) => acc?.[key], obj);

  // Derived fields (auto-filled)
  const computed = {
    companyName: "BuildSmart Construction LLC",
    companyAddress: "42 Industrial Park Rd, Austin, TX",
    companyLicense: "LIC-56789",
    ownerName: "Michael Carter",
    ownerTitle: "Managing Director",
    currentDate: new Date().toLocaleDateString(),
    validUntil: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toLocaleDateString(),
    project: { data: { name: data.project } },
    client: {
      data: {
        name: "John Doe",
        phone: "+1 (555) 123-4567",
        email: "john.doe@example.com",
      },
    },
    overview: data.scope,
    totalAmount: `$${data.total.toFixed(2)}`,
    amountPlumbing: "$200",
    amountLighting: "$300",
    amountFlooring: "$2.50/sqft",
    initialPayment: `$${(data.total * 0.3).toFixed(2)}`,
    milestonePayment: `$${(data.total * 0.6).toFixed(2)}`,
    finalPayment: `$${(data.total * 0.1).toFixed(2)}`,
    scopeItems: data.items
      .map(
        (item) => `
          <tr>
            <td>${item.Category || "Other"}</td>
            <td>${item.description}</td>
            <td>$${item.total.toFixed(2)}</td>
          </tr>`
      )
      .join(""),
    plan: data.plan
      .map(
        (p) => `
        <p><strong>${p.milestone}</strong> (${p.date}) — ${p.details}</p>`
      )
      .join(""),
  };

  // Merge sample + computed
  const finalData = { ...data, ...computed };

  return template.replace(/{{(.*?)}}/g, (_, key) => {
    const value = getValue(key, finalData);
    return value ?? "";
  });
}


module.exports = { htmlTemplate, renderTemplate };
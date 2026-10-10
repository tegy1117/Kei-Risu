import { createSign } from 'node:crypto'

// Server build replaces only the browser OAuth transport with this leaf.
export async function exchangeServiceAccountForAccessToken(input: any) {
    const sa = input.serviceAccount
    const uri = 'https://oauth2.googleapis.com/token'
    if (sa.tokenUri !== uri) throw new Error('Unsupported Google token URI.')
    const now = Date.now()
    const header: Record<string, string> = { alg: 'RS256', typ: 'JWT' }
    if (sa.privateKeyId) header.kid = sa.privateKeyId
    const encoded = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url')
    const signingInput = `${encoded(header)}.${encoded({ iss: sa.clientEmail, scope: input.scope, aud: uri, iat: Math.floor(now / 1000), exp: Math.floor(now / 1000) + 3600 })}`
    const signature = createSign('RSA-SHA256').update(signingInput).end().sign(sa.privateKey).toString('base64url')
    const response = await fetch(uri, { method: 'POST', signal: input.abortSignal, headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${signingInput}.${signature}` }) })
    if (!response.ok) throw new Error(`Google token exchange failed (${response.status}).`)
    const token = await response.json()
    return { accessToken: token.access_token, tokenType: token.token_type || 'Bearer', expiresInSeconds: token.expires_in, issuedAtMs: now }
}

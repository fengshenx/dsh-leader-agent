import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createPublicKey, createVerify, generateKeyPairSync } from 'node:crypto'
import { base64url, createJwt, partsOf } from '../scripts/github-app-jwt.mjs'

// 测试自己造一对密钥：不碰本机凭据，也不让用例依赖那台机器
const { privateKey, publicKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
})

test('base64url 去掉填充并把 +/ 换成 -_', () => {
  assert.equal(base64url(Buffer.from([0xfb, 0xff])), '-_8')
  assert.equal(base64url(''), '')
  assert.equal(base64url('a'), 'YQ')
})

test('JWT 的 header 声明 RS256 与 JWT 类型', () => {
  const { header } = partsOf(createJwt({ appId: '4881745', privateKey, nowSeconds: 1_700_000_000 }))
  assert.deepEqual(header, { alg: 'RS256', typ: 'JWT' })
})

test('JWT 的 payload 用 appId 作 iss，iat 回退 60 秒、exp 取 9 分钟', () => {
  const { payload } = partsOf(createJwt({ appId: '4881745', privateKey, nowSeconds: 1_700_000_000 }))
  assert.deepEqual(payload, { iat: 1_699_999_940, exp: 1_700_000_540, iss: '4881745' })
})

test('签名能用对应公钥验过，且 payload 被改就验不过', () => {
  const jwt = createJwt({ appId: '4881745', privateKey, nowSeconds: 1_700_000_000 })
  const { signingInput, signature } = partsOf(jwt)
  const verifier = createVerify('RSA-SHA256')
  verifier.update(signingInput)
  assert.equal(verifier.verify(createPublicKey(publicKey), Buffer.from(signature, 'base64url')), true)

  const tampered = createVerify('RSA-SHA256')
  tampered.update(`${signingInput}x`)
  assert.equal(tampered.verify(createPublicKey(publicKey), Buffer.from(signature, 'base64url')), false)
})

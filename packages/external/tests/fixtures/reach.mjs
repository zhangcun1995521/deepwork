/**
 * A stand-in for a deployment's own connector.
 *
 * The suite's configured command is `node <this file> {url}`, which is the shape a real deployment
 * has: a program the deployment owns, given the address of the route the domain declared, reading
 * the credential out of its environment. Nothing about it is special to the test except that it is
 * small — it dials a real socket, over real HTTP, and its exit status is the only thing the connector
 * under test is allowed to read.
 *
 * The credential is sent as a bearer token so the test's server can prove it travelled: an assertion
 * that a secret reached a child process is otherwise a claim about an environment variable object,
 * and the whole reason the name is neutral is that the trip through the environment is where it
 * breaks.
 *
 * Exits 2 when it is given no address and 3 when the credential is empty, so a suite that lost either
 * one reports which, rather than failing as a connection error that looks like a network problem.
 */

const [address] = process.argv.slice(2)
if (address === undefined) {
  process.stderr.write('reach: no address was given\n')
  process.exit(2)
}

const credential = process.env.DEEPWORK_REACH_CREDENTIAL ?? ''
if (credential.length === 0) {
  process.stderr.write('reach: DEEPWORK_REACH_CREDENTIAL is empty\n')
  process.exit(3)
}

try {
  const response = await fetch(address, { headers: { authorization: `Bearer ${credential}` } })
  process.stdout.write(await response.text())
  process.exitCode = response.ok ? 0 : 1
} catch (error) {
  process.stderr.write(`reach: ${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
}

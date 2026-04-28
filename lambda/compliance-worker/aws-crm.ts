/**
 * aws-crm.ts — AWS Customer Responsibility Matrix for NIST 800-53 Rev 5
 *
 * Based on AWS FedRAMP High P-ATO (GovCloud) Customer Responsibility Matrix.
 * Source: AWS Artifact → "AWS FedRAMP High Customer Responsibility Matrix"
 *
 * Three responsibility tiers:
 *   'aws'      — AWS is fully responsible. Customer inherits this control via AWS FedRAMP ATO.
 *                No customer action required. Narrative is pre-filled.
 *   'shared'   — Shared responsibility. AWS provides the capability; customer must configure
 *                and operate it for their workload. Bedrock generates customer-side narrative.
 *   'customer' — Customer is fully responsible. Bedrock generates the full narrative.
 *
 * Controls not listed here default to 'customer'.
 */

export type AwsResponsibility = 'aws' | 'shared' | 'customer';

export interface CrmEntry {
  responsibility: AwsResponsibility;
  /** One sentence describing AWS's contribution. Used in prompt context and pre-filled narratives. */
  awsNote: string;
}

// ── AWS-inherited controls (customer fully inherits) ──────────────────────────
// Source: AWS operates all physical infrastructure; PE controls are fully inherited.
// MA controls for AWS-managed hardware are inherited. SC hypervisor/hardware layer inherited.

const AWS_FULL: Record<string, string> = {
  // Physical and Environmental Protection — all inherited (AWS datacenters)
  'PE-1':  'AWS maintains and publishes physical security policies for all data center locations.',
  'PE-2':  'AWS enforces physical access authorizations using multi-factor authentication and biometrics at all facilities.',
  'PE-2(3)':'AWS employs security escorts and visitor controls at all data center locations.',
  'PE-3':  'AWS controls physical access to all facilities using layered access controls including badge readers, biometrics, and security cameras.',
  'PE-3(1)':'AWS distributes physical security mechanisms across multiple independently operated facilities.',
  'PE-3(2)':'AWS performs physical access control using automated systems at all data center entry points.',
  'PE-4':  'AWS controls physical access to transmission and distribution lines within its facilities.',
  'PE-5':  'AWS controls physical access to output devices within its facilities.',
  'PE-6':  'AWS monitors physical access using security cameras, alarm systems, and 24/7 security personnel.',
  'PE-6(1)':'AWS integrates physical access logs with its security information and event management systems.',
  'PE-6(2)':'AWS monitors physical access using automated recognition systems.',
  'PE-6(4)':'AWS monitors physical access using automated intrusion detection systems.',
  'PE-8':  'AWS maintains visitor access records for all data center facilities.',
  'PE-8(1)':'AWS coordinates visitor access records with incident response activities.',
  'PE-9':  'AWS protects power equipment and power cabling at all facilities.',
  'PE-10': 'AWS provides emergency shutoff capabilities for all power equipment.',
  'PE-11': 'AWS provides uninterruptible power supply (UPS) for short-term power outages.',
  'PE-11(1)':'AWS provides long-term alternate power supply for all critical systems.',
  'PE-12': 'AWS provides and maintains emergency lighting at all facilities.',
  'PE-13': 'AWS employs fire suppression and detection devices at all facilities.',
  'PE-13(1)':'AWS links fire detection devices to automatic notification systems.',
  'PE-13(2)':'AWS employs automatic fire suppression capabilities at all facilities.',
  'PE-15': 'AWS protects information systems from water damage at all facilities.',
  'PE-15(1)':'AWS employs automated mechanisms to detect water and alert personnel.',
  'PE-16': 'AWS controls and manages the entry and exit of information system components at all facilities.',
  'PE-17': 'AWS provides protections for alternate work sites used by AWS personnel.',
  'PE-17(1)':'AWS implements remote access security controls at alternate work sites.',
  'PE-18': 'AWS positions information system components to minimize potential damage from physical and environmental hazards.',

  // Maintenance tools and remote maintenance — AWS manages underlying hardware
  'MA-3':   'AWS employs maintenance tools for information system hardware at AWS-managed facilities.',
  'MA-3(1)':'AWS inspects maintenance tools brought into facilities by authorized personnel.',
  'MA-3(2)':'AWS inspects maintenance tools for improper or unauthorized modifications.',
  'MA-3(3)':'AWS prevents unauthorized removal of maintenance equipment from facilities.',
};

// ── Shared responsibility controls ────────────────────────────────────────────
// Customer must configure and operate their workload; AWS provides the infrastructure.

const AWS_SHARED: Record<string, string> = {
  // Configuration Management — AWS provides baseline, customer configures their resources
  'CM-2':     'AWS maintains hardened baseline configurations for managed services; customer maintains configurations for their EC2, containers, and applications.',
  'CM-2(2)':  'AWS automates configuration management for underlying infrastructure; customer must automate configuration for their workloads.',
  'CM-2(3)':  'AWS retains previous versions of infrastructure configurations; customer must retain versions of their application and OS configurations.',
  'CM-2(7)':  'AWS issues preconfigured devices for AWS personnel; customer configures organizational devices for their staff.',

  // Contingency Planning — AWS provides multi-AZ/multi-region; customer must architect for it
  'CP-6':     'AWS operates geographically separated alternate storage sites (Availability Zones and Regions); customer must configure workloads to use them.',
  'CP-6(1)':  'AWS ensures alternate storage sites are separated from primary sites; customer must replicate data to alternate AWS regions.',
  'CP-6(3)':  'AWS identifies potential accessibility problems for alternate storage sites; customer must test failover to alternate regions.',
  'CP-7':     'AWS provides alternate processing capability via multiple Regions; customer must design and test multi-region architecture.',
  'CP-7(1)':  'AWS geographically separates primary and alternate processing sites; customer must activate alternate region processing.',
  'CP-7(2)':  'AWS enables initiation of recovery activities at alternate processing sites; customer must maintain runbooks and test regional failover.',
  'CP-7(3)':  'AWS priority-restores information system components at alternate sites; customer must configure Route 53 and load balancers for failover.',
  'CP-7(4)':  'AWS prepares alternate processing sites for use as operational sites; customer must maintain parity between primary and alternate region deployments.',
  'CP-8':     'AWS provides diverse telecom services across its global network; customer must configure redundant network paths for their workloads.',
  'CP-8(1)':  'AWS provides priority-of-service provisions in telecom agreements; customer must configure QoS and network redundancy for their applications.',
  'CP-8(2)':  'AWS obtains alternate telecom services from separate providers; customer must architect multi-carrier connectivity where required.',
  'CP-8(3)':  'AWS provides VPN and dedicated connectivity options (Direct Connect); customer must implement redundant WAN links.',
  'CP-8(4)':  'AWS requires telecom providers to have contingency plans; customer must document network contingency procedures.',

  // Identification and Authentication — AWS provides IAM; customer must configure it
  'IA-3':     'AWS uniquely identifies EC2 instances, containers, and managed services; customer must manage device identity for their registered devices.',

  // Incident Response — AWS provides GuardDuty, Security Hub; customer must configure and respond
  'IR-6(3)':  'AWS reports incidents to US-CERT and relevant authorities; customer must report incidents involving their data.',

  // System and Communications Protection — AWS provides VPC, TLS, KMS; customer must use them
  'SC-5':     'AWS protects against denial-of-service attacks using AWS Shield Standard; customer must configure Shield Advanced for their internet-facing resources.',
  'SC-5(1)':  'AWS restricts incoming traffic to prevent DoS attacks; customer must configure Security Groups, WAF, and Shield Advanced.',
  'SC-5(2)':  'AWS manages excess capacity and bandwidth for the underlying infrastructure; customer must configure Auto Scaling and load balancing for their workloads.',
  'SC-7':     'AWS implements network boundary protections at the infrastructure level; customer must configure VPC, security groups, and NACLs for their workloads.',
  'SC-7(3)':  'AWS enforces access control at managed service endpoints; customer must configure security group rules to limit information access at their application boundaries.',
  'SC-7(4)':  'AWS implements external telecommunications services controls; customer must configure VPC routing and network ACLs to implement external boundary controls.',
  'SC-7(5)':  'AWS denies network traffic by default at infrastructure boundaries; customer must configure VPC security groups with deny-by-default rules.',
  'SC-7(7)':  'AWS prevents split tunneling for AWS-managed remote access; customer must prevent split tunneling in their VPN configurations.',
  'SC-7(8)':  'AWS routes outbound traffic through managed gateways; customer must configure VPC route tables and NAT Gateways to route traffic through approved gateways.',
  'SC-7(18)': 'AWS fails securely at network boundary components; customer must configure their load balancers and firewalls to fail securely.',
  'SC-7(21)': 'AWS implements boundary protection with isolation techniques; customer must use separate VPCs for isolation of system components.',
  'SC-8':     'AWS provides TLS for all managed service APIs and endpoints; customer must implement TLS in transit for their applications and enforce HTTPS.',
  'SC-8(1)':  'AWS implements cryptographic mechanisms for data in transit at the infrastructure layer; customer must enable TLS and configure certificate management for their applications.',
  'SC-12':    'AWS establishes and manages cryptographic keys for AWS-managed encryption; customer must manage their own keys in AWS KMS for customer-managed CMKs.',
  'SC-12(1)': 'AWS maintains availability of cryptographic key management (KMS); customer must configure key rotation policies and backup procedures for their CMKs.',
  'SC-13':    'AWS implements FIPS 140-2 validated cryptographic modules in AWS services; customer must ensure their applications use FIPS-validated algorithms and AWS services.',
  'SC-17':    'AWS issues and manages PKI certificates for AWS service endpoints; customer must manage PKI certificates for their applications using ACM.',
  'SC-28':    'AWS provides encryption-at-rest capabilities for all storage services (EBS, S3, RDS); customer must enable encryption for all their data stores.',
  'SC-28(1)': 'AWS provides FIPS-validated cryptographic modules for storage encryption; customer must enable and configure encryption for all their S3 buckets, EBS volumes, and RDS instances.',

  // System and Information Integrity — AWS patches infrastructure; customer patches OS/app
  'SI-2':     'AWS remediates flaws in managed services and underlying infrastructure; customer is responsible for patching their EC2 OS, containers, and application dependencies.',
  'SI-2(2)':  'AWS employs automated patch management for managed services; customer must configure Systems Manager Patch Manager or equivalent for their EC2 instances.',
  'SI-3':     'AWS provides GuardDuty and Inspector for malware detection at the infrastructure layer; customer must enable and configure these services for their workloads.',
  'SI-3(1)':  'AWS updates malicious code protection centrally for managed services; customer must ensure malware definitions are updated for their EC2 and containers.',
  'SI-3(2)':  'AWS tests malicious code protection mechanisms for managed services; customer must test antimalware controls for their workloads.',
  'SI-4':     'AWS monitors the underlying infrastructure using CloudWatch and Security Hub; customer must configure CloudWatch Logs, Security Hub, and alerting for their applications.',
  'SI-4(2)':  'AWS provides automated tools for real-time monitoring at the infrastructure level; customer must deploy monitoring agents and configure dashboards for their workloads.',
  'SI-4(4)':  'AWS monitors inbound and outbound communications at the network infrastructure level; customer must configure VPC Flow Logs and GuardDuty for their traffic.',
  'SI-7':     'AWS verifies integrity of managed services at the infrastructure level; customer must implement integrity verification for their application artifacts.',
  'SI-7(1)':  'AWS performs integrity checks on AWS-managed software and firmware; customer must implement integrity checking (e.g., AWS Config, Inspector) for their deployments.',

  // Supply Chain Risk Management
  'SR-3':     'AWS establishes supply chain risk management protections for hardware and software components; customer must manage supply chain risk for their third-party software.',
  'SR-5':     'AWS employs acquisition strategies that protect against supply chain threats; customer must apply supply chain protections to their own acquisitions.',
};

// ── Public lookup API ─────────────────────────────────────────────────────────

const CRM: Record<string, CrmEntry> = {};

for (const [id, note] of Object.entries(AWS_FULL)) {
  CRM[id] = { responsibility: 'aws', awsNote: note };
}
for (const [id, note] of Object.entries(AWS_SHARED)) {
  CRM[id] = { responsibility: 'shared', awsNote: note };
}

export function getAwsResponsibility(controlId: string): CrmEntry {
  return CRM[controlId] ?? { responsibility: 'customer', awsNote: '' };
}

/** Pre-built narrative for fully-inherited controls. */
export function inheritedNarrative(controlId: string, title: string): string {
  const entry = CRM[controlId];
  if (!entry || entry.responsibility !== 'aws') return '';
  return `This control is fully inherited from Amazon Web Services. ${entry.awsNote} ` +
    `AWS holds a FedRAMP High P-ATO and customers running workloads on AWS inherit this ` +
    `control through AWS's authorization. No additional customer action is required. ` +
    `Evidence: AWS FedRAMP package available in AWS Artifact.`;
}

export const AWS_INHERITED_IDS = new Set(Object.keys(AWS_FULL));
export const AWS_SHARED_IDS    = new Set(Object.keys(AWS_SHARED));

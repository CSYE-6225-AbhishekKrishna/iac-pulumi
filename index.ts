
import * as pulumi from "@pulumi/pulumi";
import * as aws from "@pulumi/aws";

import * as fs from "fs";

const config = new pulumi.Config();
 

// Base CIDR block
const baseCidrBlock = config.require("baseCidrBlock");


const amiId = config.require("amiId");
const destinationCidrBlock = config.require("destinationCidrBlock");
 

// Get the availability zones for the region
const complete_availabilityZones = pulumi.output(aws.getAvailabilityZones({
    state: "available"
}));

 

const availabilityZones = complete_availabilityZones.apply(az => az.names.slice(0, 3));

 

// Function to calculate the new subnet mask
function calculateNewSubnetMask(vpcMask: number, numSubnets: number): number {
    const bitsNeeded = Math.ceil(Math.log2(numSubnets));
    const newSubnetMask = vpcMask + bitsNeeded;
    return newSubnetMask;
}

 

function ipToInt(ip: string): number {
    const octets = ip.split('.').map(Number);
    return (octets[0] << 24) + (octets[1] << 16) + (octets[2] << 8) + octets[3];
}

 

function intToIp(int: number): string {
    return [(int >>> 24) & 255, (int >>> 16) & 255, (int >>> 8) & 255, int & 255].join('.');
}

 

function generateSubnetCidrBlocks(baseCidrBlock: string, numSubnets: number): string[] {
    const [baseIp, vpcMask] = baseCidrBlock.split('/');
    const newSubnetMask = calculateNewSubnetMask(Number(vpcMask), numSubnets);
    const subnetSize = Math.pow(2, 32 - newSubnetMask);
    const subnetCidrBlocks = [];
    for (let i = 0; i < numSubnets; i++) {
        const subnetIpInt = ipToInt(baseIp) + i * subnetSize;
        const subnetIp = intToIp(subnetIpInt);
        subnetCidrBlocks.push(`${subnetIp}/${newSubnetMask}`);
    }
    return subnetCidrBlocks;
}

 

 

// Create a VPC
const vpc = new aws.ec2.Vpc("my-vpc", {
    cidrBlock: baseCidrBlock,
});

 

// Create subnets
const subnetCidrBlocks = generateSubnetCidrBlocks(baseCidrBlock, 6);  // Assuming 3 public and 3 private subnets

 

const publicSubnets = availabilityZones.apply(azs =>
    azs.map((az, index) => {
        const subnet = new aws.ec2.Subnet(`public-subnet-${az}`, {
            vpcId: vpc.id,
            cidrBlock: subnetCidrBlocks[index],
            availabilityZone: az,
            mapPublicIpOnLaunch: true,
            tags: { Name: `public-subnet-${az}` }
        });
        return subnet;
    })
);

 

const privateSubnets = availabilityZones.apply(azs =>
    azs.map((az, index) => {
        const subnet = new aws.ec2.Subnet(`private-subnet-${az}`, {
            vpcId: vpc.id,
            cidrBlock: subnetCidrBlocks[index + 3],  // Offset by 3 to use different CIDR blocks for private subnets
            availabilityZone: az,
            tags: { Name: `private-subnet-${az}` }
        });
        return subnet;
    })
);

 

 

// Create an Internet Gateway
const internetGateway = new aws.ec2.InternetGateway("my-internet-gateway", {
    vpcId: vpc.id,
    tags: { Name: "my-internet-gateway" },
});

 

// Create a public route table
const publicRouteTable = new aws.ec2.RouteTable("public-route-table", {
  vpcId: vpc.id,
  tags: { Name: "public-route-table" },
});
 

// Attach all public subnets to the public route table
publicSubnets.apply(subnets => {
    subnets.forEach((subnet, index) => {
        new aws.ec2.RouteTableAssociation(`public-subnet-rt-association-${index}`, {
            subnetId: subnet.id,
            routeTableId: publicRouteTable.id,
        });
    });
});

 

// Create a private route table
const privateRouteTable = new aws.ec2.RouteTable("private-route-table", {
    vpcId: vpc.id,
    tags: { Name: "private-route-table" },
});

 

// Attach all private subnets to the private route table
privateSubnets.apply(subnets => {
    subnets.forEach((subnet, index) => {
        new aws.ec2.RouteTableAssociation(`private-subnet-rt-association-${index}`, {
            subnetId: subnet.id,
            routeTableId: privateRouteTable.id,
        });
    });
});

 

// Create a public route in the public route table
new aws.ec2.Route("public-route", {
    routeTableId: publicRouteTable.id,
    destinationCidrBlock: destinationCidrBlock,
    gatewayId: internetGateway.id,
});

 

// Export subnet IDs
export const vpcId = vpc.id;
export const publicSubnetIds = publicSubnets.apply(subnets => subnets.map(subnet => subnet.id));
export const privateSubnetIds = privateSubnets.apply(subnets => subnets.map(subnet => subnet.id));

const applicationSecurityGroup = new aws.ec2.SecurityGroup("applicationSecurityGroup", {
    vpcId: vpc.id,
    description: "Security group for web application instances",
});

// Define ingress rules for the security group
const ingressRules = [
    {
        fromPort: 22,
        toPort: 22,
        protocol: "tcp",
        cidrBlocks: [destinationCidrBlock], // Allow SSH from anywhere
    },
    {
        fromPort: 80,
        toPort: 80,
        protocol: "tcp",
        cidrBlocks: [destinationCidrBlock], // Allow HTTP from anywhere
    },
    {
        fromPort: 443,
        toPort: 443,
        protocol: "tcp",
        cidrBlocks: [destinationCidrBlock], // Allow HTTPS from anywhere
    },
    // Application port 3001
    {
        fromPort: 3001,
        toPort: 3001,
        protocol: "tcp",
        cidrBlocks: [destinationCidrBlock], // Allow HTTPS from anywhere
    },
];

ingressRules.forEach((rule, index) => {
    new aws.ec2.SecurityGroupRule(`appSecurityGroupRule${index}`, {
        securityGroupId: applicationSecurityGroup.id,
        type: "ingress",
        fromPort: rule.fromPort,
        toPort: rule.toPort,
        protocol: rule.protocol,
        cidrBlocks: rule.cidrBlocks,
    });
});

let rawKeyContent: string;
try {
    rawKeyContent = fs.readFileSync("/Users/abhik/.ssh/myawskey.pub", 'utf8').trim();
} catch (error) {
    pulumi.log.error("Error reading the public key file.");
    throw error;
}

const keyParts = rawKeyContent.split(" ");
const publicKeyContent = keyParts.length > 1 ? `${keyParts[0]} ${keyParts[1]}` : rawKeyContent;

const keyPair = new aws.ec2.KeyPair("mykeypair", {
    publicKey: publicKeyContent,
});

const keyPairName = keyPair.id.apply(id => id);


const instance = new aws.ec2.Instance("myEc2Instance", {
    ami: amiId, // Replace with your custom AMI ID
    instanceType: "t2.micro", // Choose the desired instance type
    vpcSecurityGroupIds: [applicationSecurityGroup.id], // Attach the app security group
    subnetId: publicSubnets[0].id, // Choose the appropriate subnet
    rootBlockDevice: {
        volumeSize: 25,
        volumeType: "gp2",
        deleteOnTermination: true,
    },
    // ebsBlockDevices: [
    //     {
    //         deviceName: "/dev/sdb", 
    //         volumeSize: 25,
    //         volumeType: "gp2",
    //         deleteOnTermination: true,
    //     },
    //     // Add additional EBS block devices if needed
    // ],

    disableApiTermination: false,
    keyName: keyPairName,
    tags: { Name: "MyEC2Instance" }, // Set an appropriate name
});

export const ec2InstanceId = instance.id;

import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as kinesis from 'aws-cdk-lib/aws-kinesis';
import { CfnPipe } from 'aws-cdk-lib/aws-pipes';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ec from 'aws-cdk-lib/aws-elasticache';


export class CdkStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const sourceQueue = new sqs.Queue(this, 'iot-queue', {
      visibilityTimeout: cdk.Duration.seconds(300),
    });

    const queuePolicy = new iam.PolicyDocument({
      statements: [
        new iam.PolicyStatement({
          resources: [sourceQueue.queueArn],
          actions: ['sqs:ReceiveMessage', 'sqs:DeleteMessage', 'sqs:GetQueueAttributes'],
          effect: iam.Effect.ALLOW,
        }),
      ],
    });

    const sourceStream = new kinesis.Stream(this, 'IOTStream', {
      shardCount: 1,
      retentionPeriod: cdk.Duration.days(1),
    });

    const streamPolicy = new iam.PolicyDocument({
      statements: [
        new iam.PolicyStatement({
          resources: [sourceStream.streamArn],
          actions: [            
            'kinesis:DescribeStream',
            'kinesis:DescribeStreamSummary',            
            'kinesis:GetRecords',
            'kinesis:GetShardIterator',            
            'kinesis:ListStreams',
            'kinesis:ListShards'
          ],
          effect: iam.Effect.ALLOW,
        }),
      ],
    });

    const defaultVpc = ec2.Vpc.fromLookup(this, 'VPC', {
      isDefault: true,
    });

    const stackSecurityGroup = new ec2.SecurityGroup(this, 'stack-security-group', {
      vpc: defaultVpc,
      allowAllOutbound: true            
    });
    stackSecurityGroup.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(6379), 'Allow Redis Access');

    const elasticCacheCluster = new ec.CfnCacheCluster(this, 'elastic-cache-cluster', {
      cacheNodeType: 'cache.t3.micro',
      engine: 'redis',
      numCacheNodes: 1,
      port: 6379,
      autoMinorVersionUpgrade: true,
      snapshotRetentionLimit: 1,
      snapshotWindow: '00:00-01:00',
      cacheParameterGroupName: 'default.redis6.x',
      cacheSubnetGroupName: 'default',
      engineVersion: '6.x',
      vpcSecurityGroupIds: [stackSecurityGroup.securityGroupId],
    });

    const lambdaRole = new iam.Role(this, 'lambda-role', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole'),
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaVPCAccessExecutionRole'),
      ],    
    });

    var eventProcessorLambda = new lambda.DockerImageFunction(this, 'lambda', {
      code: lambda.DockerImageCode.fromImageAsset('./sample/event-processor'),
      role: lambdaRole,
      environment: {
        REDIS_ENDPOINT: elasticCacheCluster.attrRedisEndpointAddress,
        REDIS_PORT: elasticCacheCluster.attrRedisEndpointPort        
      },
      architecture: lambda.Architecture.ARM_64,
      memorySize: 2048,
      timeout: cdk.Duration.seconds(120),
      vpc: defaultVpc,
      securityGroups: [stackSecurityGroup],
      allowPublicSubnet: true
    });
    
    const lambdaPolicy = new iam.PolicyDocument({
      statements: [
        new iam.PolicyStatement({
          resources: [eventProcessorLambda.functionArn],
          actions: [
            'lambda:InvokeFunction'            
          ],
          effect: iam.Effect.ALLOW,
        }),
      ],
    });

    const queuePipeRole = new iam.Role(this, 'queue-pipe-role', {
      assumedBy: new iam.ServicePrincipal('pipes.amazonaws.com'),
      inlinePolicies: {
        queuePolicy,        
        lambdaPolicy
      },
    });

    const queuePipe = new CfnPipe(this, 'queue-pipe', {
      roleArn: queuePipeRole.roleArn,
      source: sourceQueue.queueArn,      
      target: eventProcessorLambda.functionArn,     
      sourceParameters: {
        sqsQueueParameters: {
          batchSize: 1
        }
      },
      targetParameters: {              
        inputTemplate: `{
          "body": "<$.body>"
        }`,
      },
    });

    const streamPipeRole = new iam.Role(this, 'stream-pipe-role', {
      assumedBy: new iam.ServicePrincipal('pipes.amazonaws.com'),
      inlinePolicies: {
        streamPolicy,        
        lambdaPolicy
      },
    });

    const streamPipe = new CfnPipe(this, 'stream-pipe', {
      roleArn: streamPipeRole.roleArn,
      source: sourceStream.streamArn,      
      target: eventProcessorLambda.functionArn,
      sourceParameters: {
        kinesisStreamParameters: {
          startingPosition: 'LATEST'
        }
      },
      targetParameters: {              
        inputTemplate: `{
          "body": "<$.data>"
        }`,
      },
    });

    new cdk.CfnOutput(this, 'sqs-pipe-output', {
      exportName: 'Queue-Pipe-Output',
      value: queuePipe.attrArn,
    });

    new cdk.CfnOutput(this, 'stream-pipe-output', {
      exportName: 'Stream-Pipe-Output',
      value: streamPipe.attrArn,
    });

    new cdk.CfnOutput(this, 'sqs-queue-name-output', {
      exportName: 'SQS-Queue-Name-Output',
      value: sourceQueue.queueUrl
    });

    new cdk.CfnOutput(this, 'lambda-function-name-output', {
      exportName: 'Lambda-Function-Name-Output',
      value: eventProcessorLambda.functionName
    });
  }
}

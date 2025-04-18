import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as sfn from 'aws-cdk-lib/aws-stepfunctions';
import * as tasks from 'aws-cdk-lib/aws-stepfunctions-tasks';
import * as apigw from 'aws-cdk-lib/aws-apigateway';

export class StepFunctionJobStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // Job Lambda
    const jobLambda = new lambda.Function(this, 'JobHandler', {
      runtime: lambda.Runtime.NODEJS_18_X,
      code: lambda.Code.fromInline(`
        const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));
        exports.handler = async (event) => {
          console.log("Event received:", event);
          const counter = event.counter ?? 0;
          const isComplete = counter >= 5;
          await sleep(5000);
          return { 
            counter: counter + 1,
            isComplete,
            testEnv: event.testEnv
          };
        };
      `),
      handler: 'index.handler',
      timeout: cdk.Duration.seconds(60),
    });

    // Step function definition
    const invokeJob = new tasks.LambdaInvoke(this, 'Invoke Job Lambda', {
      lambdaFunction: jobLambda,
      resultPath: '$.lambdaResult',
      payloadResponseOnly: true,
      payload: sfn.TaskInput.fromObject({
        'counter.$': '$.counter',
        'testEnv.$': '$.testEnv'
      })
    });

    const mergeJobOutput = new sfn.Pass(this, 'Merge Job Output', {
      parameters: {
        'counter.$': '$.lambdaResult.counter',
        'isComplete.$': '$.lambdaResult.isComplete',
        'testEnv.$': '$.testEnv'
      }
    });

    const jobCompleteChoice = new sfn.Choice(this, 'Is Job Complete?');

    const jobDefinition = invokeJob
      .next(mergeJobOutput)
      .next(jobCompleteChoice
        .when(sfn.Condition.booleanEquals('$.isComplete', true), new sfn.Succeed(this, 'Job Succeeded'))
        .otherwise(invokeJob));

    const logGroup = new cdk.aws_logs.LogGroup(this, 'StepFunctionLogGroup');

    const stateMachine = new sfn.StateMachine(this, 'JobStateMachine', {
      definitionBody: sfn.DefinitionBody.fromChainable(jobDefinition),
      timeout: cdk.Duration.minutes(15),
      stateMachineType: sfn.StateMachineType.STANDARD,
      logs: {
        destination: logGroup,
        level: sfn.LogLevel.ALL,
        includeExecutionData: true,
      },
    });

    // Lambda to invoke state machine using @aws-sdk/client-sfn
    const invokeStateMachineLambda = new lambda.Function(this, 'InvokeStateMachineLambda', {
      runtime: lambda.Runtime.NODEJS_18_X,
      handler: 'index.handler',
      code: lambda.Code.fromInline(`
        const { SFNClient, StartExecutionCommand } = require('@aws-sdk/client-sfn');
        const client = new SFNClient();

        exports.handler = async (event) => {
          try {
            const input = typeof event.body === 'string' ? JSON.parse(event.body) : event.body;
            const command = new StartExecutionCommand({
              stateMachineArn: process.env.STATE_MACHINE_ARN,
              input: JSON.stringify({ testEnv: input.testEnv, counter: 0 }),
            });

            const execution = await client.send(command);
            return {
              statusCode: 200,
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ executionArn: execution.executionArn })
            };
          } catch (error) {
            console.error(error);
            return {
              statusCode: 500,
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ message: error.message })
            };
          }
        };
      `),
      environment: {
        STATE_MACHINE_ARN: stateMachine.stateMachineArn,
      },
    });

    stateMachine.grantStartExecution(invokeStateMachineLambda);

    // API Gateway
    const api = new apigw.RestApi(this, 'JobApi');
    const invokeResource = api.root.addResource('invoke-job');

    const integration = new apigw.LambdaIntegration(invokeStateMachineLambda);
    invokeResource.addMethod('POST', integration);
  }
}
